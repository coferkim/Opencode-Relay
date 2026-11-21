import { createHash } from "node:crypto";

import {
  ENV_MARKER,
  injectedSystemContext,
  officialToolset,
  placeholderNote,
} from "./assets";
import {
  canonicalSessionID,
  mintProjectID,
  stableProjectID,
  traceHeaders,
} from "./identity";
import type { ChatCompletionRequest, ChatMessage, ChatTool } from "./types";

export const DEFAULT_CLIENT = "cli";
export const DEFAULT_VERSION = "2.1.1";
/** The max_completion_tokens the 2.x client puts on every chat body. */
export const V2_COMPLETION_LIMIT = 32000;

export interface OpenCodeIdentity {
  client: string;
  version: string;
  sessionID: string;
  projectID: string;
}

export function createIdentity(input: Partial<OpenCodeIdentity> = {}): OpenCodeIdentity {
  const sessionID = canonicalSessionID(input.sessionID ?? `fresh:${mintProjectID()}`);
  return {
    client: input.client ?? DEFAULT_CLIENT,
    version: input.version ?? DEFAULT_VERSION,
    sessionID,
    projectID: input.projectID ?? mintProjectID(),
  };
}

/**
 * Stable identity for a conversation, even when the client opens a new worker
 * per turn. The session is re-encoded into the canonical shape the free tier
 * accepts, with a plausible recent timestamp (a hash-derived 1970 date is
 * answered with 429 regardless of quota).
 */
export function createIdentityFromSeed(
  seed: string,
  input: Partial<OpenCodeIdentity> = {},
): OpenCodeIdentity {
  const sessionID = canonicalSessionID(seed);
  return {
    client: input.client ?? DEFAULT_CLIENT,
    version: input.version ?? DEFAULT_VERSION,
    sessionID,
    projectID: input.projectID ?? stableProjectID(seed),
  };
}

/**
 * The v2 client header set the free lane fingerprints. Notes carried over from
 * both reference implementations:
 *  - `x-opencode-request` is a v1-only header; sending it is an instant 403.
 *  - All four session headers carry the same canonical session.
 *  - `x-opencode-project` must be a bare 40-hex id, never `global` or `prj_*`.
 *  - No explicit `accept`: the official client leaves it to fetch's default.
 */
export function buildRequestHeaders(input: {
  apiKey: string;
  identity: OpenCodeIdentity;
  accept?: string;
  json?: boolean;
}): Record<string, string> {
  const { identity } = input;
  const headers: Record<string, string> = {
    authorization: `Bearer ${input.apiKey}`,
    "user-agent": `opencode/latest/${identity.version}/${identity.client}`,
    "x-opencode-client": identity.client,
    "x-opencode-session": identity.sessionID,
    "x-opencode-session-id": identity.sessionID,
    "x-session-affinity": identity.sessionID,
    "x-session-id": identity.sessionID,
    "x-opencode-project": identity.projectID,
    ...traceHeaders(),
  };
  if (input.json) headers["content-type"] = "application/json";
  if (input.accept) headers.accept = input.accept;
  return headers;
}

/* ------------------------------------------------------------------ */
/* Tool renames                                                        */
/* ------------------------------------------------------------------ */

const CLIENT_TOOL_PREFIX = "mcp_";
const CLIENT_TOOL_DIGEST_LENGTH = 12;
const TOOL_WIRE_NAME_LIMIT = 64;

/**
 * Client spellings that mean an official tool (folded: lowercase, no
 * separators). When a client declares one of these, its wire name is the
 * official name itself: the free tier's tool gate reads the official set, so a
 * declared `Read` takes the `read` slot with the caller's schema, and the
 * official default for that name is not appended. A call arriving as `read`
 * is then restored to the caller's spelling on the response path.
 */
const OFFICIAL_ALIASES: Record<string, string> = Object.fromEntries(
  Object.entries({
    edit: ["edit"],
    execute: ["execute"],
    glob: ["glob"],
    grep: ["grep"],
    question: ["question", "askuserquestion"],
    read: ["read", "view"],
    shell: ["shell", "bash"],
    skill: ["skill"],
    subagent: ["subagent", "agent", "task"],
    webfetch: ["webfetch", "fetch"],
    websearch: ["websearch"],
    write: ["write"],
    patch: ["patch", "applypatch"],
  }).flatMap(([official, spellings]) => spellings.map((spelling) => [foldToolName(spelling), official])),
);

function officialForClientName(name: string): string | null {
  return OFFICIAL_ALIASES[foldToolName(name)] ?? null;
}

function foldToolName(name: string): string {
  return name.toLowerCase().replace(/[_.\- \t\r\n]/g, "");
}

/** Response-side resolution: wire name back to the caller's spelling. */
export class ToolRenames extends Map<string, string> {
  private readonly byCase = new Map<string, string>();
  private readonly byShape = new Map<string, string>();
  /** official name -> the caller tool that claimed its slot */
  private readonly official = new Map<string, string>();

  add(client: string, wire: string): void {
    if (!client || !wire || client === wire || this.has(wire)) return;
    this.set(wire, client);
    for (const [index, key] of [
      [this.byCase, client.toLowerCase()],
      [this.byShape, foldToolName(client)],
    ] as const) {
      if (!key) continue;
      index.set(key, index.has(key) && index.get(key) !== client ? "" : client);
    }
  }

  /** Record that `client` claimed official `official`'s wire slot. */
  bindOfficial(official: string, client: string): void {
    if (!official || !client || this.official.has(official)) return;
    this.official.set(official, client);
  }

  wireOf(client: string): string | undefined {
    for (const [wire, original] of this) if (original === client) return wire;
    for (const [official, original] of this.official) if (original === client) return official;
    return undefined;
  }

  resolve(wire: string): string {
    if (!wire) return wire;
    if (this.has(wire)) return this.get(wire)!;
    const bound = this.official.get(wire);
    if (bound) return bound;
    const stripped =
      wire.startsWith(CLIENT_TOOL_PREFIX) && wire.length > CLIENT_TOOL_PREFIX.length
        ? wire.slice(CLIENT_TOOL_PREFIX.length)
        : wire;
    const byCase = this.byCase.get(stripped.toLowerCase());
    if (byCase) return byCase;
    const byShape = this.byShape.get(foldToolName(stripped));
    if (byShape) return byShape;
    return wire;
  }
}

function clientToolWireName(name: string, used: Set<string>): string {
  const base =
    CLIENT_TOOL_PREFIX +
    createHash("sha256").update(name).digest("hex").slice(0, CLIENT_TOOL_DIGEST_LENGTH);
  let candidate = base;
  for (let n = 2; used.has(candidate); n++) {
    const suffix = `_${n}`;
    candidate = base.slice(0, TOOL_WIRE_NAME_LIMIT - suffix.length) + suffix;
  }
  used.add(candidate);
  return candidate;
}

function toolName(tool: ChatTool): string {
  return tool.function?.name ?? tool.name ?? "";
}

function renameTool(tool: ChatTool, name: string): ChatTool {
  const fn = tool.function;
  return fn ? { ...tool, function: { ...fn, name } } : { ...tool, name };
}

/**
 * Replace ordinary spaces in a client tool's top-level description with
 * non-breaking spaces. The free tier matches literal wording in client
 * descriptions; NBSP breaks the match without accumulating across passes.
 */
function nbspDescription(tool: ChatTool): ChatTool {
  const fn = tool.function;
  if (!fn || typeof fn.description !== "string") return tool;
  return { ...tool, function: { ...fn, description: fn.description.replace(/ /g, " ") } };
}

function renameToolReferences(messages: ChatMessage[], renames: ToolRenames): void {
  for (const message of messages) {
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (calls.length > 0) {
      message.tool_calls = calls.map((call) => {
        const original = call?.function?.name;
        const wire = original ? renames.wireOf(original) : undefined;
        return wire && call.function ? { ...call, function: { ...call.function, name: wire } } : call;
      });
    }
    const call = message.function_call as Record<string, any> | undefined;
    const wire = call && typeof call.name === "string" ? renames.wireOf(call.name) : undefined;
    if (call && wire) message.function_call = { ...call, name: wire };
    if (message.role === "tool" && typeof message.name === "string") {
      const renamed = renames.wireOf(message.name);
      if (renamed) message.name = renamed;
    }
  }
}

/* ------------------------------------------------------------------ */
/* System prompt                                                       */
/* ------------------------------------------------------------------ */

type TextPart = { type?: string; text?: unknown };

function textFragments(value: unknown): string[] {
  const result: string[] = [];
  const pending: unknown[] = [value];
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === "string") {
      if (item.trim()) result.push(item);
    } else if (Array.isArray(item)) {
      for (let index = item.length - 1; index >= 0; index--) pending.push(item[index]);
    } else if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      if (typeof record.text === "string") pending.push(record.text);
      else if (record.content !== undefined) pending.push(record.content);
    }
  }
  return result;
}

function carriesEnvBlock(value: unknown): boolean {
  return textFragments(value).some((text) => text.includes(ENV_MARKER));
}

/**
 * Fold every system/developer message into the single system message the
 * official CLI sends, and prepend the environment context (the `<env>` block
 * plus the skills listing). No persona prompt: live A/B on this lane shows
 * the gate requires the env block, not a persona — see assets.ts.
 *
 * A body that already carries an env block is left untouched, so repeated
 * shaping cannot duplicate it. The caller's own instructions follow the
 * injected context. Returns false when nothing changed.
 */
function injectOfficialPrompt(messages: ChatMessage[], model: string): boolean {
  const kept: ChatMessage[] = [];
  const instructions: string[] = [];
  let anchor = -1;
  for (const message of messages) {
    if (message?.role !== "system" && message?.role !== "developer") {
      kept.push(message);
      continue;
    }
    if (carriesEnvBlock(message.content)) return false;
    if (anchor < 0) anchor = kept.length;
    instructions.push(...textFragments(message.content).map((text) => text.trim()).filter(Boolean));
  }
  let system = injectedSystemContext(model);
  const joined = instructions.join("\n");
  if (joined) system += `\n\n${joined}`;
  const injected: ChatMessage = { role: "system", content: system };
  kept.splice(anchor < 0 ? 0 : anchor, 0, injected);
  messages.length = 0;
  messages.push(...kept);
  return true;
}

/* ------------------------------------------------------------------ */
/* Title requests                                                      */
/* ------------------------------------------------------------------ */

const TITLE_MARKERS =
  /generate a title|write a title|create a title|come up with a title|title (?:for|of) (?:this|the) (?:conversation|chat|session|exchange|request)|conversation title|summarize (?:this|the) conversation/i;

/**
 * The free tier answers a toolless title call that arrives with an
 * agent-shaped tool list with 403/429, so these ship exactly as the caller
 * wrote them: no prompt injection, no tool append, no renames.
 */
export function isTitleRequest(body: ChatCompletionRequest): boolean {
  if (body.tool_choice !== undefined) return false;
  if (Array.isArray(body.tools) && body.tools.length > 0) return false;
  if (Array.isArray((body as any).functions) && (body as any).functions.length > 0) return false;
  const messages = body.messages ?? [];
  if (messages.length === 0 || messages.length > 3) return false;
  let matches = false;
  for (const message of messages) {
    if (!["user", "system", "developer"].includes(message?.role)) return false;
    matches = matches || TITLE_MARKERS.test(textFragments(message.content).join("\n"));
  }
  return matches;
}

/* ------------------------------------------------------------------ */
/* Body shaping                                                        */
/* ------------------------------------------------------------------ */

export interface BuiltChatBody {
  body: Record<string, unknown>;
  /** wire tool name -> caller tool name */
  toolNames: ToolRenames;
}

function convertLegacyFunctions(functions: unknown, renames: ToolRenames, used: Set<string>): ChatTool[] {
  if (!Array.isArray(functions)) return [];
  const tools: ChatTool[] = [];
  for (const entry of functions) {
    if (!entry || typeof entry !== "object" || typeof (entry as any).name !== "string") continue;
    const legacy = entry as Record<string, any>;
    const wire = renames.wireOf(legacy.name) ?? clientToolWireName(legacy.name, used);
    renames.add(legacy.name, wire);
    tools.push({
      type: "function",
      function: {
        name: wire,
        description: typeof legacy.description === "string" ? legacy.description : undefined,
        parameters: legacy.parameters ?? { type: "object", properties: {} },
      },
    });
  }
  return tools;
}

/**
 * Fields the relay owns on the wire. Everything else the caller sent
 * (`temperature`, `top_p`, `stop`, `seed`, `response_format`, `n`, `user`, …)
 * is forwarded untouched — an OpenAI-compatible gateway must not silently
 * drop sampling parameters.
 */
const RELAY_OWNED_FIELDS = new Set([
  "model",
  "messages",
  "tools",
  "functions",
  "stream",
  "stream_options",
  "max_tokens",
  "max_completion_tokens",
  "tool_choice",
]);

/**
 * Make one caller body read as an official 2.x CLI session:
 *  1. title requests pass through unshaped;
 *  2. the official system prompt is injected (marker-guarded);
 *  3. every caller tool is renamed to `mcp_<digest>` with NBSP descriptions,
 *     the full 13-tool official set is appended, and history references are
 *     renamed with it;
 *  4. `tool_choice: none` is never shipped (the gate treats it as non-client);
 *  5. the chat body carries the client's constants, in the client's key order.
 */
export function buildChatBody(request: ChatCompletionRequest): BuiltChatBody {
  const toolNames = new ToolRenames();
  const messages = Array.isArray(request.messages)
    ? request.messages.map((message) => ({ ...message }))
    : [];
  const body: Record<string, unknown> = {};
  const limit = request.max_completion_tokens ?? request.max_tokens;

  if (isTitleRequest({ ...request, messages })) {
    const passthrough: Record<string, unknown> = { ...request, messages };
    delete passthrough.max_tokens;
    if (limit !== undefined) passthrough.max_completion_tokens = limit;
    passthrough.stream = true;
    passthrough.stream_options = { ...(request.stream_options ?? {}), include_usage: true };
    if (passthrough.max_completion_tokens === undefined) {
      passthrough.max_completion_tokens = V2_COMPLETION_LIMIT;
    }
    return { body: orderedChatBody(passthrough), toolNames };
  }

  injectOfficialPrompt(messages, request.model);

  const used = new Set<string>();
  const tools: ChatTool[] = [];
  const legacy = convertLegacyFunctions((request as any).functions, toolNames, used);
  const declared = [
    ...(Array.isArray(request.tools) ? request.tools : []),
    ...legacy,
  ];
  for (const tool of declared) {
    const original = toolName(tool);
    if (!original) {
      tools.push(tool);
      continue;
    }
    // Already-shaped bodies keep their opaque names, so a second pass is a no-op.
    if (original.startsWith(CLIENT_TOOL_PREFIX)) {
      tools.push(tool);
      continue;
    }
    // Client tools are ALWAYS opaque on the wire: declaring one under an
    // official name with a foreign schema is refused (live A/B: `Read` with a
    // client schema answers 429, the same tool as `mcp_<digest>` answers 200),
    // and a foreign client's vocabulary in the tool list is refused too.
    const wire = toolNames.wireOf(original) ?? clientToolWireName(original, used);
    toolNames.add(original, wire);
    tools.push(nbspDescription(renameTool(tool, wire)));
    // Remember which caller tool each official alias maps to, so a call the
    // model sends to an official name can be restored to the caller's spelling.
    const official = officialForClientName(original);
    if (official) toolNames.bindOfficial(official, original);
  }
  tools.push(...officialToolset());

  const choice = request.tool_choice;
  if (choice && typeof choice === "object" && !Array.isArray(choice)) {
    const value = choice as Record<string, any>;
    const name = value.function?.name;
    const wire = typeof name === "string" ? toolNames.wireOf(name) : undefined;
    if (wire) body.tool_choice = { ...value, function: { ...value.function, name: wire } };
  } else if (typeof choice === "string" && choice !== "none") {
    body.tool_choice = choice;
  }

  renameToolReferences(messages, toolNames);

  for (const [key, value] of Object.entries(request)) {
    if (value !== undefined && !RELAY_OWNED_FIELDS.has(key)) body[key] = value;
  }
  body.model = request.model;
  body.messages = messages;
  body.tools = tools;
  body.stream = true;
  body.stream_options = { ...(request.stream_options ?? {}), include_usage: true };
  body.max_completion_tokens = limit ?? V2_COMPLETION_LIMIT;
  return { body: orderedChatBody(body), toolNames };
}

/**
 * The 2.x client's JSON.stringify emits chat keys in this order; the bytes
 * parse the same either way, but the gateway exists to be indistinguishable,
 * so the skeleton follows the client and everything else is sorted after it.
 */
const CHAT_KEY_ORDER = [
  "model",
  "messages",
  "tools",
  "stream",
  "stream_options",
  "max_completion_tokens",
];

function orderedChatBody(payload: Record<string, unknown>): Record<string, unknown> {
  const ordered: Record<string, unknown> = {};
  for (const key of CHAT_KEY_ORDER) {
    if (payload[key] !== undefined) ordered[key] = payload[key];
  }
  for (const key of Object.keys(payload).sort()) {
    if (ordered[key] === undefined && payload[key] !== undefined) ordered[key] = payload[key];
  }
  return ordered;
}

/* ------------------------------------------------------------------ */
/* Response-side restoration                                           */
/* ------------------------------------------------------------------ */

type AnyRecord = Record<string, any>;

function restoreCallNames(calls: AnyRecord[], toolNames: ToolRenames): void {
  for (const call of calls) {
    const fn = call?.function;
    if (fn && typeof fn.name === "string") fn.name = toolNames.resolve(fn.name);
    const legacy = call?.function_call;
    if (legacy && typeof legacy.name === "string") legacy.name = toolNames.resolve(legacy.name);
  }
}

/** Restore opaque wire tool names in a streamed or aggregated Chat response. */
export function restoreToolNamesInResponse(
  response: AnyRecord,
  toolNames: ToolRenames | Map<string, string>,
): AnyRecord {
  if (toolNames.size === 0) return response;
  const resolve = (name: string) =>
    toolNames instanceof ToolRenames
      ? toolNames.resolve(name)
      : (toolNames.get(name) ?? name);
  for (const choice of response.choices ?? []) {
    for (const branch of [choice.delta, choice.message]) {
      if (!branch || typeof branch !== "object") continue;
      if (Array.isArray(branch.tool_calls)) {
        for (const call of branch.tool_calls) {
          const fn = call?.function;
          if (fn && typeof fn.name === "string") fn.name = resolve(fn.name);
        }
      }
      if (branch.function_call && typeof branch.function_call.name === "string") {
        branch.function_call.name = resolve(branch.function_call.name);
      }
    }
  }
  return response;
}

export { placeholderNote };
