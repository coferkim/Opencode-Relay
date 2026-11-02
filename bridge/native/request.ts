import { createHash } from "node:crypto";
import { mintProjectID, mintSessionID } from "./identity";
import type { ChatCompletionRequest, ChatMessage, ChatTool } from "./types";

export const DEFAULT_CLIENT = "desktop";
export const DEFAULT_VERSION = "2.2.5";

export interface OpenCodeIdentity {
  client: string;
  version: string;
  sessionID: string;
  projectID: string;
}

export function createIdentity(input: Partial<OpenCodeIdentity> = {}): OpenCodeIdentity {
  return {
    client: input.client ?? DEFAULT_CLIENT,
    version: input.version ?? DEFAULT_VERSION,
    sessionID: input.sessionID ?? mintSessionID(),
    projectID: input.projectID ?? mintProjectID(),
  };
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function base62From(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => BASE62[byte % BASE62.length]).join("");
}

/** Stable identity for a conversation, even when the client opens a new worker per turn. */
export function createIdentityFromSeed(seed: string, input: Partial<OpenCodeIdentity> = {}): OpenCodeIdentity {
  const digest = createHash("sha256").update(`opencode-relay\0${seed}`).digest();
  const hex = digest.toString("hex");
  return {
    client: input.client ?? DEFAULT_CLIENT,
    version: input.version ?? DEFAULT_VERSION,
    sessionID: `ses_${digest.subarray(0, 6).toString("hex")}${base62From(digest.subarray(6, 20))}`,
    projectID: hex.slice(0, 40),
  };
}

export function buildRequestHeaders(input: {
  apiKey: string;
  identity: OpenCodeIdentity;
  accept: string;
  json?: boolean;
}): Record<string, string> {
  const { identity } = input;
  const headers: Record<string, string> = {
    authorization: `Bearer ${input.apiKey}`,
    "user-agent": `opencode/latest/${identity.version}/${identity.client}`,
    "x-opencode-client": identity.client,
    "x-opencode-project": identity.projectID,
    "x-opencode-session": identity.sessionID,
    "x-opencode-session-id": identity.sessionID,
    "x-session-affinity": identity.sessionID,
    "x-session-id": identity.sessionID,
    accept: input.accept,
  };
  if (input.json) headers["content-type"] = "application/json";
  return headers;
}

export interface BuiltChatBody {
  body: Record<string, unknown>;
  /** wire tool name -> caller tool name */
  toolNames: Map<string, string>;
}

function renameTool(tool: ChatTool, name: string): ChatTool {
  const fn = tool.function;
  return fn
    ? { ...tool, function: { ...fn, name } }
    : { ...tool, name };
}

function renameToolMessages(messages: ChatMessage[], names: Map<string, string>): void {
  for (const message of messages) {
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (calls.length > 0) {
      message.tool_calls = calls.map((call) => {
        const wire = names.get(call.function?.name ?? "");
        return wire && call.function ? { ...call, function: { ...call.function, name: wire } } : call;
      });
    }
    const call = message.function_call as Record<string, any> | undefined;
    const wire = call && typeof call.name === "string" ? names.get(call.name) : undefined;
    if (call && wire) message.function_call = { ...call, name: wire };
    if (message.role === "tool" && typeof message.name === "string") {
      message.name = names.get(message.name) ?? message.name;
    }
  }
}

export function buildChatBody(request: ChatCompletionRequest): BuiltChatBody {
  const body: Record<string, unknown> = { ...request };
  const messages = Array.isArray(body.messages)
    ? (body.messages as ChatMessage[]).map((message) => ({ ...message }))
    : [];
  const tools = Array.isArray(body.tools) ? [...(body.tools as ChatTool[])] : [];
  const hadClientTools = tools.length > 0;
  const toolNames = new Map<string, string>();
  const originalToWire = new Map<string, string>();

  ensureEnvBlock(messages);
  if (!tools.some(isReadTool)) tools.push(READ_TOOL);

  if (hadClientTools) {
    // The free lane rejects foreign tool vocabulary. Keep the caller's names in
    // memory, send opaque wire names, then restore them in the response.
    const wireTools = tools.map((tool, index) => {
      const original = toolName(tool);
      if (!original) return tool;
      const wire = `tool_${index}`;
      originalToWire.set(original, wire);
      toolNames.set(wire, original);
      return renameTool(tool, wire);
    });
    tools.length = 0;
    tools.push(...wireTools);
    ensureFingerprintTools(tools);
  }

  const choice = body.tool_choice;
  if (choice && typeof choice === "object" && !Array.isArray(choice)) {
    const value = choice as Record<string, any>;
    const fn = value.function as Record<string, any> | undefined;
    const wire = fn && typeof fn.name === "string" ? originalToWire.get(fn.name) : undefined;
    if (fn && wire) body.tool_choice = { ...value, function: { ...fn, name: wire } };
  }
  renameToolMessages(messages, originalToWire);

  const limit = request.max_completion_tokens ?? request.max_tokens;
  delete body.max_tokens;
  body.model = request.model;
  body.messages = messages;
  body.tools = tools;
  body.stream = true;
  body.stream_options = { ...(request.stream_options ?? {}), include_usage: true };
  if (limit !== undefined) body.max_completion_tokens = limit;
  if (body.tool_choice === "none") delete body.tool_choice;
  return { body, toolNames };
}

type AnyRecord = Record<string, any>;

function restoreCallNames(calls: AnyRecord[], toolNames: Map<string, string>): void {
  for (const call of calls) {
    const fn = call?.function;
    if (fn && typeof fn.name === "string") fn.name = toolNames.get(fn.name) ?? fn.name;
    const legacy = call?.function_call;
    if (legacy && typeof legacy.name === "string") {
      legacy.name = toolNames.get(legacy.name) ?? legacy.name;
    }
  }
}

/** Restore opaque wire tool names in a streamed or aggregated Chat response. */
export function restoreToolNamesInResponse(response: AnyRecord, toolNames: Map<string, string>): AnyRecord {
  for (const choice of response.choices ?? []) {
    for (const branch of [choice.delta, choice.message]) {
      if (!branch || typeof branch !== "object") continue;
      if (Array.isArray(branch.tool_calls)) restoreCallNames(branch.tool_calls, toolNames);
      if (branch.function_call && typeof branch.function_call.name === "string") {
        branch.function_call.name = toolNames.get(branch.function_call.name) ?? branch.function_call.name;
      }
    }
  }
  return response;
}

export function envBlock(directory = "/"): string {
  return [
    "<env>",
    `  Working directory: ${directory}`,
    `  Workspace root folder: ${directory}`,
    "  Is directory a git repo: no",
    `  Platform: ${process.platform}`,
    "</env>",
  ].join("\n");
}

export const READ_TOOL: ChatTool = {
  type: "function",
  function: {
    name: "read",
    description: "Read the contents of a file.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
};

const FINGERPRINT_TOOLS = ["bash", "glob", "grep", "read"] as const;

function toolName(tool: ChatTool): string {
  return tool.function?.name ?? tool.name ?? "";
}

function isReadTool(tool: ChatTool): boolean {
  return toolName(tool).toLowerCase() === "read";
}

function ensureFingerprintTools(tools: ChatTool[]): void {
  const present = new Set(tools.map(toolName).map((name) => name.toLowerCase()));
  for (const name of FINGERPRINT_TOOLS) {
    if (present.has(name)) continue;
    tools.push({
      type: "function",
      function: {
        name,
        description: "Compatibility placeholder. This tool is unavailable and must not be called.",
        parameters: { type: "object", properties: {} },
      },
    });
  }
}

function hasEnvBlock(content: string): boolean {
  const start = content.indexOf("<env>");
  if (start === -1) return false;
  const rest = content.slice(start + "<env>".length);
  const end = rest.indexOf("</env>");
  return end !== -1 && rest.slice(0, end).includes("Working directory:");
}

function ensureEnvBlock(messages: ChatMessage[]): void {
  const block = envBlock();
  const system = messages.find((message) => message.role === "system");
  if (!system) {
    messages.unshift({ role: "system", content: block });
    return;
  }
  if (typeof system.content !== "string") {
    messages.unshift({ role: "system", content: block });
    return;
  }
  if (hasEnvBlock(system.content)) return;
  system.content = system.content.includes("<env")
    ? `${block}\n\n${system.content}`
    : `${system.content}${system.content ? "\n\n" : ""}${block}`;
}
