/**
 * Protocol bridge: one neutral representation for the three client-facing
 * protocols this gateway serves, and the codecs between it and the upstream
 * Chat Completions wire.
 *
 *   Anthropic Messages ─┐
 *   OpenAI Chat ────────┼─ decode ─▶ BridgeRequest ─ encode ─▶ Chat wire ─▶ shaping
 *   OpenAI Responses ───┘
 *
 *   upstream Chat SSE ─▶ BridgeEvent stream ─▶ Anthropic / Responses SSE
 *   upstream Chat completion ─▶ BridgeResponse ─▶ Anthropic / Responses JSON
 *
 * The upstream free lane only speaks Chat Completions, so every client
 * protocol is converted to that wire and back. Tool names are resolved back to
 * the caller's spelling through the request's ToolRenames map on the way out.
 */
import { randomBytes } from "node:crypto";

import type { ChatCompletionRequest, ChatMessage, ChatTool } from "./types";
import type { ToolRenames } from "./request";

export type ClientProtocol = "chat" | "anthropic" | "responses";

/* ------------------------------------------------------------------ */
/* Neutral model                                                       */
/* ------------------------------------------------------------------ */

export interface BridgeImage {
  mediaType?: string;
  url?: string;
  data?: string;
}

export type BridgeBlock =
  | { type: "text"; text: string }
  | { type: "image"; image: BridgeImage }
  | { type: "tool_call"; id: string; name: string; arguments: string }
  | { type: "tool_result"; toolCallId: string; content: string; isError?: boolean };

export interface BridgeMessage {
  role: "user" | "assistant";
  blocks: BridgeBlock[];
}

export interface BridgeTool {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

export type BridgeToolChoice =
  | { mode: "auto" | "none" | "required" }
  | { mode: "named"; name: string };

export interface BridgeRequest {
  model: string;
  system: string[];
  messages: BridgeMessage[];
  tools: BridgeTool[];
  toolChoice?: BridgeToolChoice;
  stream: boolean;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
  reasoningEffort?: string;
  responseFormat?: unknown;
  metadata?: unknown;
  /** Anthropic thinking request, projected onto the response side. */
  thinkingRequested?: boolean;
  /** Fields the client sent that the neutral model does not name. */
  extra: Record<string, unknown>;
}

export interface BridgeUsage {
  input: number;
  output: number;
  total: number;
  cached: number;
  reasoning: number;
}

export interface BridgeToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface BridgeResponse {
  id: string;
  model: string;
  created: number;
  text: string;
  reasoning: string;
  toolCalls: BridgeToolCall[];
  finishReason: string | null;
  usage: BridgeUsage;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

export function randomId(prefix: string, bytes = 12): string {
  return `${prefix}_${randomBytes(bytes).toString("hex")}`;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
      .join("");
  }
  return "";
}

/** Decode an OpenAI image_url value (data URL or remote URL) into a bridge image. */
export function imageFromUrl(url: string): BridgeImage {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (match) return { mediaType: match[1], data: match[2] };
  return { url };
}

export function imageToUrl(image: BridgeImage): string {
  if (image.url) return image.url;
  return `data:${image.mediaType ?? "image/png"};base64,${image.data ?? ""}`;
}

function anthropicToolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts = content
      .map((block) => (isRecord(block) && block.type === "text" && typeof block.text === "string" ? block.text : ""))
      .filter(Boolean);
    if (texts.length) return texts.join("\n");
  }
  return "";
}

function toolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (content === null || content === undefined) return "";
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

/* ------------------------------------------------------------------ */
/* Decoders: client protocol -> BridgeRequest                          */
/* ------------------------------------------------------------------ */

const CHAT_OWNED = new Set([
  "model",
  "messages",
  "tools",
  "functions",
  "tool_choice",
  "stream",
  "max_tokens",
  "max_completion_tokens",
  "temperature",
  "top_p",
  "stop",
  "reasoning_effort",
  "response_format",
  "metadata",
]);

function decodeChatContent(content: unknown): BridgeBlock[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const blocks: BridgeBlock[] = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    if (part.type === "text" && typeof part.text === "string") {
      blocks.push({ type: "text", text: part.text });
    } else if (part.type === "image_url" && isRecord(part.image_url) && typeof part.image_url.url === "string") {
      blocks.push({ type: "image", image: imageFromUrl(part.image_url.url) });
    }
  }
  return blocks;
}

export function decodeChatRequest(body: Record<string, unknown>): BridgeRequest {
  const system: string[] = [];
  const messages: BridgeMessage[] = [];
  const rawMessages = Array.isArray(body.messages) ? (body.messages as Record<string, any>[]) : [];
  for (const message of rawMessages) {
    if (!isRecord(message)) continue;
    const role = String(message.role ?? "");
    if (role === "system" || role === "developer") {
      const text = textOf(message.content);
      if (text) system.push(text);
      continue;
    }
    if (role === "tool" || role === "function") {
      const toolCallId = String(message.tool_call_id ?? message.name ?? "");
      messages.push({
        role: "user",
        blocks: [{ type: "tool_result", toolCallId, content: toolResultContent(message.content) }],
      });
      continue;
    }
    if (role !== "user" && role !== "assistant") continue;
    const blocks = decodeChatContent(message.content);
    if (role === "assistant" && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        if (!isRecord(call) || !isRecord(call.function)) continue;
        blocks.push({
          type: "tool_call",
          id: String(call.id ?? ""),
          name: String(call.function.name ?? ""),
          arguments: typeof call.function.arguments === "string" ? call.function.arguments : "{}",
        });
      }
    }
    if (blocks.length > 0) messages.push({ role, blocks });
  }

  const tools: BridgeTool[] = [];
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      if (!isRecord(tool)) continue;
      const fn = isRecord(tool.function) ? tool.function : tool;
      if (typeof fn.name !== "string" || !fn.name) continue;
      tools.push({
        name: fn.name,
        description: typeof fn.description === "string" ? fn.description : undefined,
        parameters: isRecord(fn.parameters) ? fn.parameters : { type: "object", properties: {} },
      });
    }
  }

  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (value !== undefined && !CHAT_OWNED.has(key)) extra[key] = value;
  }

  return {
    model: String(body.model ?? ""),
    system,
    messages,
    tools,
    toolChoice: decodeChatToolChoice(body.tool_choice),
    stream: body.stream === true,
    maxTokens: numberOrUndefined(body.max_completion_tokens ?? body.max_tokens),
    temperature: numberOrUndefined(body.temperature),
    topP: numberOrUndefined(body.top_p),
    stop: Array.isArray(body.stop) ? body.stop.map(String) : typeof body.stop === "string" ? [body.stop] : undefined,
    reasoningEffort: typeof body.reasoning_effort === "string" ? body.reasoning_effort : undefined,
    responseFormat: body.response_format,
    metadata: body.metadata,
    extra,
  };
}

function decodeChatToolChoice(choice: unknown): BridgeToolChoice | undefined {
  if (choice === "auto" || choice === "none" || choice === "required") return { mode: choice };
  if (isRecord(choice) && isRecord(choice.function) && typeof choice.function.name === "string") {
    return { mode: "named", name: choice.function.name };
  }
  return undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function decodeAnthropicRequest(body: Record<string, unknown>): BridgeRequest {
  const system: string[] = [];
  if (typeof body.system === "string") {
    if (body.system) system.push(body.system);
  } else if (Array.isArray(body.system)) {
    for (const block of body.system) {
      if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
        system.push(block.text);
      }
    }
  }

  const messages: BridgeMessage[] = [];
  const rawMessages = Array.isArray(body.messages) ? (body.messages as Record<string, any>[]) : [];
  for (const message of rawMessages) {
    if (!isRecord(message)) continue;
    const role = String(message.role ?? "");
    if (role !== "user" && role !== "assistant") continue;
    const blocks: BridgeBlock[] = [];
    const content = message.content;
    if (typeof content === "string") {
      if (content) blocks.push({ type: "text", text: content });
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (!isRecord(block)) continue;
        switch (block.type) {
          case "text":
            if (typeof block.text === "string" && block.text) blocks.push({ type: "text", text: block.text });
            break;
          case "image": {
            const source = block.source;
            if (isRecord(source)) {
              if (source.type === "base64" && typeof source.data === "string") {
                blocks.push({
                  type: "image",
                  image: { mediaType: typeof source.media_type === "string" ? source.media_type : "image/png", data: source.data },
                });
              } else if (source.type === "url" && typeof source.url === "string") {
                blocks.push({ type: "image", image: { url: source.url } });
              }
            }
            break;
          }
          case "tool_use":
            blocks.push({
              type: "tool_call",
              id: String(block.id ?? ""),
              name: String(block.name ?? ""),
              arguments: JSON.stringify(block.input ?? {}),
            });
            break;
          case "tool_result":
            blocks.push({
              type: "tool_result",
              toolCallId: String(block.tool_use_id ?? ""),
              content: anthropicToolResultText(block.content),
              isError: block.is_error === true,
            });
            break;
          // thinking / redacted_thinking / document: not representable on the
          // chat wire; dropped rather than refused.
          default:
            break;
        }
      }
    }
    if (blocks.length > 0) messages.push({ role, blocks });
  }

  const tools: BridgeTool[] = [];
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      if (!isRecord(tool) || typeof tool.name !== "string" || !tool.name) continue;
      tools.push({
        name: tool.name,
        description: typeof tool.description === "string" ? tool.description : undefined,
        parameters: isRecord(tool.input_schema) ? tool.input_schema : { type: "object", properties: {} },
      });
    }
  }

  let toolChoice: BridgeToolChoice | undefined;
  if (isRecord(body.tool_choice)) {
    const type = body.tool_choice.type;
    if (type === "auto") toolChoice = { mode: "auto" };
    else if (type === "any") toolChoice = { mode: "required" };
    else if (type === "none") toolChoice = { mode: "none" };
    else if (type === "tool" && typeof body.tool_choice.name === "string") {
      toolChoice = { mode: "named", name: body.tool_choice.name };
    }
  }

  const thinking = isRecord(body.thinking) ? body.thinking : undefined;
  const thinkingRequested = thinking?.type === "enabled";
  const extra: Record<string, unknown> = {};
  if (body.top_k !== undefined) extra.top_k = body.top_k;
  if (body.metadata !== undefined) extra.metadata = body.metadata;
  if (body.service_tier !== undefined) extra.service_tier = body.service_tier;

  return {
    model: String(body.model ?? ""),
    system,
    messages,
    tools,
    toolChoice,
    stream: body.stream === true,
    maxTokens: numberOrUndefined(body.max_tokens),
    temperature: numberOrUndefined(body.temperature),
    topP: numberOrUndefined(body.top_p),
    stop: Array.isArray(body.stop_sequences) ? body.stop_sequences.map(String) : undefined,
    reasoningEffort: thinkingRequested
      ? thinkingBudgetToEffort(numberOrUndefined(thinking?.budget_tokens))
      : undefined,
    metadata: body.metadata,
    thinkingRequested,
    extra,
  };
}

function thinkingBudgetToEffort(budget: number | undefined): string | undefined {
  if (budget === undefined) return undefined;
  if (budget <= 4096) return "low";
  if (budget <= 16384) return "medium";
  return "high";
}

export function decodeResponsesRequest(body: Record<string, unknown>): BridgeRequest {
  const system: string[] = [];
  if (typeof body.instructions === "string" && body.instructions) system.push(body.instructions);

  const messages: BridgeMessage[] = [];
  const input = body.input;
  if (typeof input === "string") {
    if (input) messages.push({ role: "user", blocks: [{ type: "text", text: input }] });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (!isRecord(item)) continue;
      const type = item.type;
      if (type === "function_call" || type === "custom_tool_call") {
        const block: BridgeBlock = {
          type: "tool_call",
          id: String(item.call_id ?? item.id ?? ""),
          name: String(item.name ?? ""),
          arguments: typeof item.arguments === "string" ? item.arguments : "{}",
        };
        const last = messages.at(-1);
        if (last?.role === "assistant") last.blocks.push(block);
        else messages.push({ role: "assistant", blocks: [block] });
        continue;
      }
      if (type === "function_call_output" || type === "custom_tool_call_output") {
        messages.push({
          role: "user",
          blocks: [
            {
              type: "tool_result",
              toolCallId: String(item.call_id ?? ""),
              content: toolResultContent(item.output),
            },
          ],
        });
        continue;
      }
      if (type === "reasoning" || type === "item_reference") continue;
      const role = String(item.role ?? "user");
      if (role === "system" || role === "developer") {
        const text = textOf(item.content);
        if (text) system.push(text);
        continue;
      }
      if (role !== "user" && role !== "assistant") continue;
      const blocks = decodeResponsesContent(item.content);
      if (blocks.length > 0) messages.push({ role, blocks });
    }
  }

  const tools: BridgeTool[] = [];
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      if (!isRecord(tool) || tool.type !== "function" || typeof tool.name !== "string" || !tool.name) continue;
      tools.push({
        name: tool.name,
        description: typeof tool.description === "string" ? tool.description : undefined,
        parameters: isRecord(tool.parameters) ? tool.parameters : { type: "object", properties: {} },
      });
    }
  }

  let toolChoice: BridgeToolChoice | undefined;
  if (body.tool_choice === "auto" || body.tool_choice === "none" || body.tool_choice === "required") {
    toolChoice = { mode: body.tool_choice };
  } else if (isRecord(body.tool_choice) && typeof body.tool_choice.name === "string") {
    toolChoice = { mode: "named", name: body.tool_choice.name };
  }

  const text = isRecord(body.text) ? body.text : undefined;
  const format = text && isRecord(text.format) ? text.format : undefined;
  let responseFormat: unknown;
  if (format) {
    if (format.type === "json_schema") {
      responseFormat = {
        type: "json_schema",
        json_schema: {
          name: format.name ?? "output",
          schema: format.schema ?? {},
          ...(format.strict !== undefined ? { strict: format.strict } : {}),
        },
      };
    } else if (format.type === "json_object") {
      responseFormat = { type: "json_object" };
    }
  }

  const reasoning = isRecord(body.reasoning) ? body.reasoning : undefined;
  const extra: Record<string, unknown> = {};
  if (body.parallel_tool_calls !== undefined) extra.parallel_tool_calls = body.parallel_tool_calls;
  if (body.truncation !== undefined) extra.truncation = body.truncation;
  if (body.user !== undefined) extra.user = body.user;

  return {
    model: String(body.model ?? ""),
    system,
    messages,
    tools,
    toolChoice,
    stream: body.stream === true,
    maxTokens: numberOrUndefined(body.max_output_tokens),
    temperature: numberOrUndefined(body.temperature),
    topP: numberOrUndefined(body.top_p),
    reasoningEffort: reasoning && typeof reasoning.effort === "string" ? reasoning.effort : undefined,
    responseFormat,
    metadata: body.metadata,
    extra,
  };
}

function decodeResponsesContent(content: unknown): BridgeBlock[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const blocks: BridgeBlock[] = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    if ((part.type === "input_text" || part.type === "output_text" || part.type === "text") && typeof part.text === "string") {
      blocks.push({ type: "text", text: part.text });
    } else if (part.type === "input_image" && typeof part.image_url === "string") {
      blocks.push({ type: "image", image: imageFromUrl(part.image_url) });
    }
  }
  return blocks;
}

/* ------------------------------------------------------------------ */
/* Encoder: BridgeRequest -> upstream Chat wire                        */
/* ------------------------------------------------------------------ */

export function encodeChatWire(request: BridgeRequest): ChatCompletionRequest {
  const messages: ChatMessage[] = [];
  if (request.system.length > 0) {
    messages.push({ role: "system", content: request.system.join("\n\n") });
  }

  for (const message of request.messages) {
    // Tool results must directly follow the assistant turn that asked for
    // them on the chat wire, so they are lifted out ahead of any text.
    for (const block of message.blocks) {
      if (block.type !== "tool_result") continue;
      messages.push({ role: "tool", tool_call_id: block.toolCallId, content: block.content });
    }
    const rest = message.blocks.filter((block) => block.type !== "tool_result");
    if (rest.length === 0) continue;

    if (message.role === "assistant") {
      const text = rest
        .filter((block): block is Extract<BridgeBlock, { type: "text" }> => block.type === "text")
        .map((block) => block.text)
        .join("");
      const toolCalls = rest
        .filter((block): block is Extract<BridgeBlock, { type: "tool_call" }> => block.type === "tool_call")
        .map((block) => ({
          id: block.id || randomId("call", 8),
          type: "function" as const,
          function: { name: block.name, arguments: block.arguments },
        }));
      const assistant: ChatMessage = { role: "assistant", content: text || (toolCalls.length ? null : "") };
      if (toolCalls.length > 0) assistant.tool_calls = toolCalls;
      messages.push(assistant);
      continue;
    }

    const parts: unknown[] = [];
    for (const block of rest) {
      if (block.type === "text") parts.push({ type: "text", text: block.text });
      else if (block.type === "image") parts.push({ type: "image_url", image_url: { url: imageToUrl(block.image) } });
    }
    const onlyText = parts.every((part) => (part as { type: string }).type === "text");
    if (onlyText) {
      messages.push({
        role: "user",
        content: parts.map((part) => (part as { text: string }).text).join(""),
      });
    } else {
      messages.push({ role: "user", content: parts });
    }
  }

  const wire: Record<string, unknown> = { ...request.extra };
  wire.model = request.model;
  wire.messages = messages;
  if (request.tools.length > 0) {
    wire.tools = request.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        ...(tool.description !== undefined ? { description: tool.description } : {}),
        parameters: tool.parameters,
      },
    }));
  }
  if (request.toolChoice) {
    wire.tool_choice =
      request.toolChoice.mode === "named"
        ? { type: "function", function: { name: request.toolChoice.name } }
        : request.toolChoice.mode;
  }
  wire.stream = request.stream;
  if (request.maxTokens !== undefined) wire.max_tokens = request.maxTokens;
  if (request.temperature !== undefined) wire.temperature = request.temperature;
  if (request.topP !== undefined) wire.top_p = request.topP;
  if (request.stop !== undefined) wire.stop = request.stop;
  if (request.reasoningEffort !== undefined) wire.reasoning_effort = request.reasoningEffort;
  if (request.responseFormat !== undefined) wire.response_format = request.responseFormat;
  if (request.metadata !== undefined) wire.metadata = request.metadata;
  return wire as ChatCompletionRequest;
}

/* ------------------------------------------------------------------ */
/* Decoder: upstream Chat completion -> BridgeResponse                 */
/* ------------------------------------------------------------------ */

export function decodeChatCompletion(
  completion: Record<string, any>,
  toolNames?: ToolRenames,
): BridgeResponse {
  const choice = completion.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const resolve = (name: string) => toolNames?.resolve(name) ?? name;
  const toolCalls: BridgeToolCall[] = Array.isArray(message.tool_calls)
    ? message.tool_calls.map((call: any) => ({
        id: String(call?.id ?? randomId("call", 8)),
        name: resolve(String(call?.function?.name ?? "")),
        arguments: typeof call?.function?.arguments === "string" ? call.function.arguments : "{}",
      }))
    : [];
  const usage = completion.usage ?? {};
  const input = Number(usage.prompt_tokens ?? 0);
  const output = Number(usage.completion_tokens ?? 0);
  return {
    id: String(completion.id ?? randomId("chatcmpl", 12)),
    model: String(completion.model ?? ""),
    created: Number(completion.created ?? Math.floor(Date.now() / 1000)),
    text: typeof message.content === "string" ? message.content : "",
    reasoning: typeof message.reasoning_content === "string" ? message.reasoning_content : "",
    toolCalls,
    finishReason: choice.finish_reason ?? null,
    usage: {
      input,
      output,
      total: Number(usage.total_tokens ?? input + output),
      cached: Number(usage.prompt_tokens_details?.cached_tokens ?? 0),
      reasoning: Number(usage.completion_tokens_details?.reasoning_tokens ?? 0),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Encoders: BridgeResponse -> client protocol JSON                    */
/* ------------------------------------------------------------------ */

export function mapStopReason(finishReason: string | null): string {
  switch (finishReason) {
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "content_filter":
      return "refusal";
    default:
      return "end_turn";
  }
}

export interface AnthropicContext {
  thinkingRequested: boolean;
  stopSequences?: string[];
}

export function toAnthropicMessage(response: BridgeResponse, context: AnthropicContext): Record<string, unknown> {
  const content: Record<string, unknown>[] = [];
  if (context.thinkingRequested && response.reasoning) {
    content.push({ type: "thinking", thinking: response.reasoning, signature: "" });
  }
  if (response.text) content.push({ type: "text", text: response.text });
  for (const call of response.toolCalls) {
    let input: unknown = {};
    try {
      const parsed = JSON.parse(call.arguments || "{}");
      input = isRecord(parsed) ? parsed : {};
    } catch {
      input = {};
    }
    content.push({ type: "tool_use", id: call.id || randomId("toolu", 12), name: call.name, input });
  }
  if (content.length === 0) content.push({ type: "text", text: "" });

  let stopReason = mapStopReason(response.finishReason);
  let stopSequence: string | null = null;
  if (stopReason === "end_turn" && context.stopSequences?.length) {
    stopReason = "stop_sequence";
    stopSequence = context.stopSequences[0] ?? null;
  }

  const usage: Record<string, unknown> = {
    input_tokens: response.usage.input,
    output_tokens: response.usage.output,
  };
  if (response.usage.cached > 0) usage.cache_read_input_tokens = response.usage.cached;

  return {
    id: randomId("msg", 12),
    type: "message",
    role: "assistant",
    model: response.model,
    content,
    stop_reason: stopReason,
    stop_sequence: stopSequence,
    usage,
  };
}

export interface ResponsesContext {
  id: string;
  createdAt: number;
  status: "completed" | "incomplete";
  incompleteReason?: string;
  instructions?: string | null;
  maxOutputTokens?: number | null;
  previousResponseId?: string | null;
  store: boolean;
  temperature?: number | null;
  topP?: number | null;
  tools?: unknown[];
  toolChoice?: unknown;
  metadata?: Record<string, unknown>;
  parallelToolCalls?: boolean;
  reasoningEffort?: string;
}

export function responsesOutput(response: BridgeResponse): Record<string, unknown>[] {
  const output: Record<string, unknown>[] = [];
  if (response.text) {
    output.push({
      type: "message",
      id: randomId("msg", 12),
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: response.text, annotations: [] }],
    });
  }
  for (const call of response.toolCalls) {
    output.push({
      type: "function_call",
      id: randomId("fc", 12),
      call_id: call.id || randomId("call", 12),
      name: call.name,
      arguments: call.arguments,
      status: "completed",
    });
  }
  return output;
}

export function toResponsesObject(response: BridgeResponse, context: ResponsesContext): Record<string, unknown> {
  const output = responsesOutput(response);
  const usage = {
    input_tokens: response.usage.input,
    input_tokens_details: { cached_tokens: response.usage.cached },
    output_tokens: response.usage.output,
    output_tokens_details: { reasoning_tokens: response.usage.reasoning },
    total_tokens: response.usage.total,
  };
  return {
    id: context.id,
    object: "response",
    created_at: context.createdAt,
    status: context.status,
    error: null,
    incomplete_details: context.status === "incomplete" ? { reason: context.incompleteReason ?? "max_output_tokens" } : null,
    instructions: context.instructions ?? null,
    max_output_tokens: context.maxOutputTokens ?? null,
    model: response.model,
    output,
    output_text: response.text,
    parallel_tool_calls: context.parallelToolCalls ?? true,
    previous_response_id: context.previousResponseId ?? null,
    reasoning: context.reasoningEffort ? { effort: context.reasoningEffort, summary: null } : null,
    store: context.store,
    temperature: context.temperature ?? null,
    text: { format: { type: "text" } },
    tool_choice: context.toolChoice ?? "auto",
    tools: context.tools ?? [],
    top_p: context.topP ?? null,
    truncation: "disabled",
    usage,
    user: null,
    metadata: context.metadata ?? {},
  };
}

/** Rough token estimate for /v1/messages/count_tokens. */
export function estimateInputTokens(request: BridgeRequest): number {
  let chars = 0;
  for (const text of request.system) chars += text.length;
  for (const message of request.messages) {
    for (const block of message.blocks) {
      if (block.type === "text") chars += block.text.length;
      else if (block.type === "tool_call") chars += block.name.length + block.arguments.length;
      else if (block.type === "tool_result") chars += block.content.length;
    }
  }
  for (const tool of request.tools) {
    chars += tool.name.length + (tool.description?.length ?? 0) + JSON.stringify(tool.parameters).length;
  }
  return Math.max(1, Math.ceil(chars / 3));
}
