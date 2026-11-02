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

export function buildChatBody(request: ChatCompletionRequest): Record<string, unknown> {
  const body: Record<string, unknown> = { ...request };
  const messages = Array.isArray(body.messages)
    ? (body.messages as ChatMessage[]).map((message) => ({ ...message }))
    : [];
  const tools = Array.isArray(body.tools) ? [...(body.tools as ChatTool[])] : [];

  ensureEnvBlock(messages);
  if (!tools.some(isReadTool)) tools.push(READ_TOOL);

  const limit = request.max_completion_tokens ?? request.max_tokens;
  delete body.max_tokens;
  body.model = request.model;
  body.messages = messages;
  body.tools = tools;
  body.stream = true;
  body.stream_options = { ...(request.stream_options ?? {}), include_usage: true };
  if (limit !== undefined) body.max_completion_tokens = limit;
  if (body.tool_choice === "none") delete body.tool_choice;
  return body;
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

function isReadTool(tool: ChatTool): boolean {
  return tool.function?.name === "read" || tool.name === "read";
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
