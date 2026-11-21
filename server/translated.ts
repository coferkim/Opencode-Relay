/**
 * Protocol-shaped handlers for the two translated client APIs:
 *
 *   POST /v1/messages              Anthropic Messages
 *   POST /v1/messages/count_tokens Anthropic token counting
 *   POST /v1/responses             OpenAI Responses
 *
 * Both decode their own wire into the bridge model, encode a Chat Completions
 * request for the free lane, and translate the upstream's streamed reply back
 * into their own protocol (SSE events or one JSON object). Errors use each
 * protocol's own envelope.
 */
import { anthropicErrorBody, errorBody, RelayError } from "./errors";
import {
  decodeAnthropicRequest,
  decodeResponsesRequest,
  encodeChatWire,
  estimateInputTokens,
  randomId,
  toAnthropicMessage,
  toResponsesObject,
  type BridgeRequest,
  type ResponsesContext,
} from "./protocol/bridge";
import {
  anthropicSseStream,
  collapseChatStream,
  responsesSseStream,
} from "./protocol/stream-bridge";
import type { ChatCompletionRequest } from "./protocol/types";
import type { ManagedResponse } from "./upstream";

export interface TranslatedDeps {
  /** Resolve the upstream key (store override or the configured fallback). */
  upstreamKey(): string;
  openChat(
    request: ChatCompletionRequest,
    apiKey: string,
    seed: string | null,
    signal?: AbortSignal,
  ): Promise<ManagedResponse>;
  forwardedHeaders(source: Headers): Headers;
}

/** Shape of the response side a handler must produce. */
export type ErrorProtocol = "anthropic" | "openai";

export function protocolErrorResponse(protocol: ErrorProtocol, error: RelayError): Response {
  const headers = new Headers({ "content-type": "application/json" });
  if (error.status === 401) headers.set("x-relay-auth-error", "1");
  const body =
    protocol === "anthropic"
      ? anthropicErrorBody(error.message, error.code, error.status)
      : errorBody(error.message, error.code, error.errorType);
  return new Response(JSON.stringify(body), { status: error.status, headers });
}

function parseJsonBody(text: string): Record<string, unknown> {
  if (!text.trim()) {
    throw new RelayError("请求体必须是 JSON 对象。", 400, "invalid_request", "invalid_request_error");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new RelayError("body: 必须是合法 JSON。", 400, "invalid_request", "invalid_request_error");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RelayError("body: 必须是 JSON 对象。", 400, "invalid_request", "invalid_request_error");
  }
  return value as Record<string, unknown>;
}

function validateBridgeRequest(request: BridgeRequest, fields: string[]): void {
  const problems: string[] = [];
  if (!request.model || request.model.length > 256) {
    problems.push("model: 必须是非空字符串，最多 256 字符。");
  }
  if (request.messages.length === 0) {
    problems.push("messages: 至少需要一条消息。");
  }
  if (request.maxTokens !== undefined && (!Number.isInteger(request.maxTokens) || request.maxTokens <= 0)) {
    problems.push("max_tokens: 必须为正整数。");
  }
  for (const field of fields) {
    const value = (request as unknown as Record<string, unknown>)[field];
    if (value !== undefined && value !== null && typeof value !== "number") {
      problems.push(`${field}: 必须是数字。`);
    }
  }
  if (problems.length > 0) {
    throw new RelayError(problems.join("; "), 400, "invalid_request", "invalid_request_error");
  }
}

async function openTranslated(
  deps: TranslatedDeps,
  request: BridgeRequest,
  signal: AbortSignal,
  seed: string | null,
): Promise<ManagedResponse> {
  const wire = encodeChatWire(request);
  return deps.openChat(wire, deps.upstreamKey(), seed, signal);
}

/** Upstream failure -> protocol error, preserving status and retry-after. */
async function upstreamFailure(
  managed: ManagedResponse,
  protocol: ErrorProtocol,
  deps: TranslatedDeps,
): Promise<Response> {
  const text = await managed.response.text();
  let message = text.slice(0, 1000) || "上游请求失败。";
  let code = "upstream_error";
  try {
    const parsed = JSON.parse(text);
    const error = parsed?.error;
    if (error && typeof error === "object") {
      if (typeof error.message === "string") message = error.message;
      if (typeof error.type === "string") code = error.type;
    }
  } catch {
    /* Keep the raw text. */
  }
  const status = managed.response.status;
  const headers = deps.forwardedHeaders(managed.response.headers);
  headers.set("content-type", "application/json");
  const body =
    protocol === "anthropic"
      ? anthropicErrorBody(message, code, status)
      : errorBody(message, code);
  return new Response(JSON.stringify(body), { status, headers });
}

/* ------------------------------------------------------------------ */
/* Anthropic Messages                                                  */
/* ------------------------------------------------------------------ */

export async function handleAnthropicMessages(
  bodyText: string,
  signal: AbortSignal,
  deps: TranslatedDeps,
  seed: string | null,
): Promise<Response> {
  const request = decodeAnthropicRequest(parseJsonBody(bodyText));
  validateBridgeRequest(request, ["temperature", "top_p"]);

  const managed = await openTranslated(deps, request, signal, seed);
  if (managed.response.status >= 400) {
    try {
      return await upstreamFailure(managed, "anthropic", deps);
    } finally {
      managed.release();
    }
  }
  if (!managed.response.body) {
    managed.release();
    throw new RelayError("上游响应为空。", 502, "invalid_upstream_response");
  }

  const context = {
    thinkingRequested: request.thinkingRequested === true,
    stopSequences: request.stop,
  };

  if (request.stream) {
    const headers = deps.forwardedHeaders(managed.response.headers);
    headers.set("content-type", "text/event-stream");
    headers.set("cache-control", "no-cache");
    headers.set("x-accel-buffering", "no");
    return new Response(
      anthropicSseStream(managed.response.body, managed.toolNames, context),
      { status: 200, headers },
    );
  }

  try {
    const response = await collapseChatStream(managed.response.body, managed.toolNames);
    return new Response(JSON.stringify(toAnthropicMessage(response, context)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } finally {
    managed.release();
  }
}

export async function handleAnthropicCountTokens(bodyText: string): Promise<Response> {
  const request = decodeAnthropicRequest(parseJsonBody(bodyText));
  validateBridgeRequest(request, ["temperature", "top_p"]);
  return new Response(JSON.stringify({ input_tokens: estimateInputTokens(request) }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/* ------------------------------------------------------------------ */
/* OpenAI Responses                                                    */
/* ------------------------------------------------------------------ */

export async function handleResponses(
  bodyText: string,
  signal: AbortSignal,
  deps: TranslatedDeps,
  seed: string | null,
): Promise<Response> {
  const raw = parseJsonBody(bodyText);
  const request = decodeResponsesRequest(raw);
  validateBridgeRequest(request, ["temperature", "top_p"]);

  const context: ResponsesContext = {
    id: randomId("resp", 16),
    createdAt: Math.floor(Date.now() / 1000),
    status: "completed",
    instructions: typeof raw.instructions === "string" ? raw.instructions : null,
    maxOutputTokens: request.maxTokens ?? null,
    previousResponseId: typeof raw.previous_response_id === "string" ? raw.previous_response_id : null,
    store: raw.store === true,
    temperature: request.temperature ?? null,
    topP: request.topP ?? null,
    tools: Array.isArray(raw.tools) ? raw.tools : [],
    toolChoice: raw.tool_choice ?? "auto",
    metadata: raw.metadata && typeof raw.metadata === "object" ? (raw.metadata as Record<string, unknown>) : {},
    parallelToolCalls: typeof raw.parallel_tool_calls === "boolean" ? raw.parallel_tool_calls : undefined,
    reasoningEffort: request.reasoningEffort,
  };

  const managed = await openTranslated(deps, request, signal, seed);
  if (managed.response.status >= 400) {
    try {
      return await upstreamFailure(managed, "openai", deps);
    } finally {
      managed.release();
    }
  }
  if (!managed.response.body) {
    managed.release();
    throw new RelayError("上游响应为空。", 502, "invalid_upstream_response");
  }

  if (request.stream) {
    const headers = deps.forwardedHeaders(managed.response.headers);
    headers.set("content-type", "text/event-stream");
    headers.set("cache-control", "no-cache");
    headers.set("x-accel-buffering", "no");
    return new Response(
      responsesSseStream(managed.response.body, managed.toolNames, context),
      { status: 200, headers },
    );
  }

  try {
    const response = await collapseChatStream(managed.response.body, managed.toolNames);
    const incomplete = response.finishReason === "length";
    return new Response(
      JSON.stringify(
        toResponsesObject(response, {
          ...context,
          status: incomplete ? "incomplete" : "completed",
          incompleteReason: incomplete ? "max_output_tokens" : undefined,
        }),
      ),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  } finally {
    managed.release();
  }
}
