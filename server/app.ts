import { assertSameOrigin, getCookie, isSecureRequest, sessionCookie } from "./auth";
import { loadSettings, type Settings } from "./config";
import { errorBody, RelayError } from "./errors";
import { aggregateChat } from "./protocol/aggregate";
import { restoreToolNamesInResponse, type ToolRenames } from "./protocol/request";
import { parseSSE } from "./protocol/sse";
import type { ChatCompletionRequest, ChatMessage } from "./protocol/types";
import { ConfigStore, SESSION_COOKIE } from "./store";
import { log, maskKey, shortSession } from "./log";
import {
  handleAnthropicCountTokens,
  handleAnthropicMessages,
  handleResponses,
  protocolErrorResponse,
  type TranslatedDeps,
} from "./translated";
import { toRelayError, Upstream } from "./upstream";
import {
  parseJsonObject,
  parseKeyInput,
  stableStringify,
  stripCredentialFields,
  validateChatRequest,
} from "./validation";

const FORWARDED_HEADERS = new Set([
  "retry-after",
  "x-request-id",
  "x-opencode-log-id",
  "x-zen-model",
]);

export interface AppOptions {
  settings?: Partial<Settings>;
  index?: Bun.HTMLBundle;
}

export interface RelayApp {
  server: Bun.Server<unknown>;
  store: ConfigStore;
  upstream: Upstream;
  stop(): void;
}

function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  return new Response(JSON.stringify(data), { ...init, headers });
}

function noStore(headers = new Headers()): Headers {
  headers.set("cache-control", "no-store");
  return headers;
}

function errorResponse(error: RelayError): Response {
  const headers = new Headers({ "content-type": "application/json" });
  if (error.status === 401) headers.set("x-relay-auth-error", "1");
  return new Response(
    JSON.stringify(errorBody(error.message, error.code, error.errorType)),
    { status: error.status, headers },
  );
}

function forwardedHeaders(source: Headers): Headers {
  const headers = new Headers();
  for (const [name, value] of source.entries()) {
    if (FORWARDED_HEADERS.has(name.toLowerCase())) headers.set(name, value);
  }
  return headers;
}

/** One-shot probes get a fresh session; agent/tool loops keep one stable identity. */
function conversationSeed(request: Request, body: Record<string, unknown>): string | null {
  const messages = Array.isArray(body.messages) ? (body.messages as ChatMessage[]) : [];
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  if (!hasTools) return null;
  for (const message of messages) {
    if (message && typeof message === "object" && message.role === "user") {
      return `user:${stableStringify(message.content)}`;
    }
  }
  for (const name of [
    "x-opencode-session",
    "x-opencode-session-id",
    "x-session-id",
    "x-session-affinity",
    "x-conversation-id",
    "conversation-id",
  ]) {
    const value = (request.headers.get(name) ?? "").trim();
    if (value) return `header:${value}`;
  }
  for (const name of ["conversation_id", "session_id", "thread_id"]) {
    const value = body[name];
    if (typeof value === "string" && value.trim()) return `body:${value.trim()}`;
  }
  return `model:${String(body.model ?? "")}`;
}

function decodeUpstreamJson(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new RelayError("上游返回了无效的 JSON 响应。", 502, "invalid_upstream_response");
  }
}

export function createApp(options: AppOptions = {}): RelayApp {
  const settings = loadSettings(options.settings);
  const store = new ConfigStore(settings.dataDir, settings.relayApiKey);
  const upstream = new Upstream(settings);

  log.info("relay.start", {
    port: settings.port,
    upstream: settings.opencodeBaseUrl,
    client: `${settings.opencodeClient}/${settings.opencodeVersion}`,
    timeout_s: settings.timeoutSeconds,
    max_concurrent: settings.maxConcurrent,
    data_dir: settings.dataDir,
    key_created: store.keyExists(),
  });

  const guard =
    (handler: (request: Request) => Promise<Response> | Response) =>
    async (request: Request): Promise<Response> => {
      const started = performance.now();
      const url = new URL(request.url);
      const elapsed = () => Math.round(performance.now() - started);
      let status = 500;
      try {
        const response = await handler(request);
        status = response.status;
        return response;
      } catch (error) {
        if (request.signal.aborted) {
          status = 499;
          return new Response(null, { status: 499 });
        }
        if (error instanceof RelayError) {
          status = error.status;
          log.warn("relay.request.failed", {
            method: request.method,
            path: url.pathname,
            status: error.status,
            code: error.code,
            message: error.message,
            ms: elapsed(),
          });
          return errorResponse(error);
        }
        const mapped = toRelayError(error, request.signal);
        if (mapped) {
          status = mapped.status;
          log.warn("relay.request.failed", {
            method: request.method,
            path: url.pathname,
            status: mapped.status,
            code: mapped.code,
            message: mapped.message,
            ms: elapsed(),
          });
          return errorResponse(mapped);
        }
        log.error("relay.request.error", {
          method: request.method,
          path: url.pathname,
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          ms: elapsed(),
        });
        return errorResponse(new RelayError("服务内部错误。", 500, "internal_error"));
      } finally {
        log.info("relay.request", {
          method: request.method,
          path: url.pathname,
          status,
          ms: elapsed(),
        });
      }
    };

  async function readJson(request: Request, optional = false): Promise<Record<string, unknown>> {
    const text = await request.text();
    if (!text.trim()) {
      if (optional) return {};
      throw new RelayError(
        "请求体必须是 JSON 对象。",
        400,
        "invalid_request",
        "invalid_request_error",
      );
    }
    return parseJsonObject(text);
  }

  function authorize(request: Request): void {
    const authorization = request.headers.get("authorization");
    let allowed: boolean;
    if (authorization !== null) {
      const [scheme, ...rest] = authorization.split(" ");
      const key = rest.join(" ");
      allowed = scheme.toLowerCase() === "bearer" && store.verifyKey(key);
    } else {
      const token = getCookie(request, SESSION_COOKIE);
      allowed = store.verifySession(token);
      if (allowed) assertSameOrigin(request);
    }
    if (!allowed) {
      const message = store.keyExists()
        ? "调用 API Key 无效。"
        : "请先在 Web 设置页创建调用 API Key。";
      throw new RelayError(message, 401, "invalid_api_key");
    }
    const query = new URL(request.url).searchParams;
    if (
      request.headers.get("x-opencode-api-key") !== null ||
      ["api_key", "apikey", "opencode_api_key"].some((name) => query.has(name))
    ) {
      throw new RelayError(
        "请在 Web 设置页修改 OpenCode API Key；调用接口只需提供调用 API Key。",
        400,
        "upstream_key_not_allowed",
      );
    }
  }

  function browserSession(request: Request): string {
    assertSameOrigin(request);
    const token = getCookie(request, SESSION_COOKIE);
    if (!store.verifySession(token)) {
      throw new RelayError("请使用调用 API Key 登录设置页。", 401, "session_expired");
    }
    return token;
  }

  async function upstreamError(response: Response): Promise<Response> {
    const body = await response.text();
    let data: Record<string, any>;
    try {
      const parsed = JSON.parse(body);
      if (
        !parsed ||
        typeof parsed !== "object" ||
        !parsed.error ||
        typeof parsed.error !== "object"
      ) {
        throw new Error();
      }
      data = parsed;
    } catch {
      data = errorBody(body.slice(0, 1000) || "上游请求失败。", "upstream_error");
    }
    // OpenAI clients read `param` and `code` off every error object; the
    // upstream envelope omits them when they do not apply. Fill the slots
    // rather than dropping the envelope's own facts.
    const error = data.error as Record<string, unknown>;
    if (!("param" in error)) error.param = null;
    if (!("code" in error)) error.code = error.type ?? null;
    if (typeof error.type !== "string") error.type = "api_error";
    return json(data, { status: response.status, headers: forwardedHeaders(response.headers) });
  }

  function forwardSse(
    source: ReadableStream<Uint8Array>,
    toolNames: ToolRenames,
    release: () => void,
    clientSignal: AbortSignal,
  ): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const iterator = parseSSE(source);
    let finished = false;
    let cancelled = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      release();
    };
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await iterator.next();
          if (cancelled) return;
          if (next.done) {
            controller.close();
            finish();
            return;
          }
          const event = next.value;
          let data = event.data;
          if (data !== "[DONE]") {
            try {
              const payload = JSON.parse(data);
              restoreToolNamesInResponse(payload, toolNames);
              data = JSON.stringify(payload);
            } catch {
              /* Preserve non-JSON events verbatim. */
            }
          }
          const fields = [
            event.event !== "message" ? `event: ${event.event}` : "",
            event.id !== undefined ? `id: ${event.id}` : "",
            event.retry !== undefined ? `retry: ${event.retry}` : "",
            `data: ${data}`,
          ].filter(Boolean);
          controller.enqueue(encoder.encode(`${fields.join("\n")}\n\n`));
        } catch (error) {
          if (clientSignal.aborted) {
            try {
              controller.close();
            } catch {
              /* Already closed. */
            }
          } else {
            const relayError =
              toRelayError(error, clientSignal) ??
              new RelayError(
                error instanceof Error ? error.message : "上游流式响应失败。",
                502,
                "upstream_error",
              );
            const payload = errorBody(relayError.message, relayError.code);
            try {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`,
                ),
              );
              controller.close();
            } catch {
              /* Already closed. */
            }
          }
          finish();
        }
      },
      cancel() {
        cancelled = true;
        void iterator.return(undefined);
        finish();
      },
    });
  }

  const translatedDeps: TranslatedDeps = {
    upstreamKey: () => store.upstreamKey(settings.opencodeApiKey),
    openChat: (request, apiKey, seed, signal) =>
      upstream.openChat(request, apiKey, seed, signal),
    forwardedHeaders,
  };

  /** Seed for translated APIs: the caller's conversation identity when it has one. */
  function translatedSeed(request: Request, body: Record<string, unknown>): string | null {
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    if (!hasTools) return null;
    for (const name of [
      "x-opencode-session",
      "x-opencode-session-id",
      "x-session-id",
      "x-session-affinity",
      "x-conversation-id",
      "conversation-id",
    ]) {
      const value = (request.headers.get(name) ?? "").trim();
      if (value) return `header:${value}`;
    }
    const previous = body.previous_response_id;
    if (typeof previous === "string" && previous) return `previous:${previous}`;
    const firstUser = Array.isArray(body.messages) ? body.messages[0] : undefined;
    if (firstUser && typeof firstUser === "object") {
      const content = (firstUser as Record<string, unknown>).content;
      if (typeof content === "string") return `user:${stableStringify(content)}`;
    }
    return `model:${String(body.model ?? "")}`;
  }

  async function handleModels(request: Request): Promise<Response> {
    authorize(request);
    const freeOnly = ["1", "true", "yes"].includes(
      (new URL(request.url).searchParams.get("free_only") ?? "").toLowerCase(),
    );
    const managed = await upstream.openModels(
      store.upstreamKey(settings.opencodeApiKey),
      request.signal,
    );
    try {
      if (managed.response.status >= 400) return await upstreamError(managed.response);
      const catalog = decodeUpstreamJson(await managed.response.text());
      if (!Array.isArray(catalog.data)) {
        throw new RelayError("上游模型列表缺少 data 数组。", 502, "invalid_upstream_response");
      }
      const data = (catalog.data as unknown[])
        .filter(
          (model): model is Record<string, any> =>
            Boolean(model) &&
            typeof model === "object" &&
            Boolean((model as Record<string, any>).id) &&
            isChatModel(model as Record<string, any>) &&
            (!freeOnly || isFreeModel(model as Record<string, any>)),
        )
        .map((model) => ({
          ...model,
          object: "model",
          created: typeof model.created === "number" ? model.created : 0,
          owned_by: typeof model.owned_by === "string" ? model.owned_by : "opencode",
          is_free: isFreeModel(model),
        }));
      return json({ object: "list", data });
    } finally {
      managed.release();
    }
  }

  /** OpenAI's GET /v1/models/{model}: 200 with the model object, 404 when unknown. */
  async function handleModel(request: Request, id: string): Promise<Response> {
    authorize(request);
    const managed = await upstream.openModels(
      store.upstreamKey(settings.opencodeApiKey),
      request.signal,
    );
    try {
      if (managed.response.status >= 400) return await upstreamError(managed.response);
      const catalog = decodeUpstreamJson(await managed.response.text());
      const match = (Array.isArray(catalog.data) ? (catalog.data as unknown[]) : []).find(
        (model): model is Record<string, any> =>
          Boolean(model) &&
          typeof model === "object" &&
          (model as Record<string, any>).id === id &&
          isChatModel(model as Record<string, any>),
      );
      if (!match) {
        throw new RelayError(
          `The model '${id}' does not exist or you do not have access to it.`,
          404,
          "model_not_found",
          "invalid_request_error",
        );
      }
      return json({
        ...match,
        object: "model",
        created: typeof match.created === "number" ? match.created : 0,
        owned_by: typeof match.owned_by === "string" ? match.owned_by : "opencode",
        is_free: isFreeModel(match),
      });
    } finally {
      managed.release();
    }
  }

  async function handleChat(request: Request): Promise<Response> {
    const started = performance.now();
    authorize(request);
    const payload = validateChatRequest(await readJson(request));
    const upstreamRequest = stripCredentialFields(payload as Record<string, unknown>);
    const seed = conversationSeed(request, upstreamRequest);
    const upstreamKey = store.upstreamKey(settings.opencodeApiKey);
    const tools = Array.isArray(upstreamRequest.tools) ? upstreamRequest.tools.length : 0;
    log.info("relay.chat.start", {
      model: payload.model,
      stream: payload.stream === true,
      messages: Array.isArray(upstreamRequest.messages) ? upstreamRequest.messages.length : 0,
      tools,
      seed: shortSession(seed),
      key: maskKey(upstreamKey),
    });
    const managed = await upstream.openChat(
      upstreamRequest as ChatCompletionRequest,
      upstreamKey,
      seed,
      request.signal,
    );
    log.info("relay.chat.upstream", {
      model: payload.model,
      status: managed.response.status,
      retry_after: managed.response.headers.get("retry-after") ?? undefined,
      log_id: managed.response.headers.get("x-opencode-log-id") ?? undefined,
      session: shortSession(seed),
      ms: Math.round(performance.now() - started),
    });
    // A free-lane 429 is scoped to the session, and the upstream ties risk and
    // quota bookkeeping to it: retrying under a fresh identity charges a new
    // bucket and makes the next real request worse, so the status is relayed
    // as-is (both reference implementations keep the id stable for this reason).

    if (managed.response.status >= 400 || !payload.stream) {
      try {
        if (managed.response.status >= 400) return await upstreamError(managed.response);
        if (!managed.response.body) {
          throw new RelayError("上游响应为空。", 502, "invalid_upstream_response");
        }
        let aggregated: Record<string, any>;
        try {
          aggregated = await aggregateChat(managed.response.body);
        } catch (error) {
          throw (
            toRelayError(error, request.signal) ??
            new RelayError(
              error instanceof Error ? error.message : "上游流式响应失败。",
              502,
              "upstream_error",
            )
          );
        }
        restoreToolNamesInResponse(aggregated, managed.toolNames);
        return json(aggregated, { headers: forwardedHeaders(managed.response.headers) });
      } finally {
        managed.release();
      }
    }

    if (!managed.response.body) {
      managed.release();
      throw new RelayError("上游响应为空。", 502, "invalid_upstream_response");
    }
    const headers = forwardedHeaders(managed.response.headers);
    headers.set("content-type", "text/event-stream");
    headers.set("cache-control", "no-cache");
    headers.set("x-accel-buffering", "no");
    return new Response(
      forwardSse(managed.response.body, managed.toolNames, managed.release, request.signal),
      { status: managed.response.status, headers },
    );
  }

  const routes: Record<string, unknown> = {
    "/api/health": {
      GET: guard(() =>
        json({
          status: "ok",
          transport: "bun-native",
          auth_required: true,
          api_key_created: store.keyExists(),
        }),
      ),
    },
    "/api/session": {
      GET: guard((request) =>
        json(
          {
            authenticated: store.verifySession(getCookie(request, SESSION_COOKIE)),
            api_key_created: store.keyExists(),
          },
          { headers: noStore() },
        ),
      ),
      POST: guard(async (request: Request) => {
        assertSameOrigin(request);
        const body = await readJson(request, true);
        const token = store.login(
          parseKeyInput(body.api_key),
          getCookie(request, SESSION_COOKIE),
        );
        const headers = noStore();
        headers.set("set-cookie", sessionCookie(token, isSecureRequest(request)));
        return json({ authenticated: true }, { headers });
      }),
      DELETE: guard((request: Request) => {
        assertSameOrigin(request);
        store.logout(getCookie(request, SESSION_COOKIE));
        const headers = noStore();
        headers.set("set-cookie", sessionCookie(null, isSecureRequest(request)));
        return json({ authenticated: false }, { headers });
      }),
    },
    "/api/settings": {
      GET: guard((request: Request) => {
        browserSession(request);
        return json(store.publicSettings(settings.opencodeApiKey), {
          headers: noStore(),
        });
      }),
    },
    "/api/settings/api-key": {
      POST: guard((request: Request) => {
        const token = browserSession(request);
        const key = store.issueKey(token);
        return json({ api_key: key }, { status: 201, headers: noStore() });
      }),
    },
    "/api/settings/api-key/rotate": {
      POST: guard((request: Request) => {
        const token = browserSession(request);
        const key = store.issueKey(token, true);
        return json({ api_key: key }, { headers: noStore() });
      }),
    },
    "/api/settings/upstream": {
      PUT: guard(async (request: Request) => {
        const token = browserSession(request);
        const body = await readJson(request);
        store.saveUpstream(token, parseKeyInput(body.api_key));
        return json(store.publicSettings(settings.opencodeApiKey), {
          headers: noStore(),
        });
      }),
    },
    "/v1/models": { GET: guard(handleModels) },
    "/v1/models/:id": {
      GET: guard((request) => {
        const id = (request as unknown as { params: { id: string } }).params?.id ?? "";
        return handleModel(request, decodeURIComponent(id));
      }),
    },
    "/v1/chat/completions": { POST: guard(handleChat) },
    "/v1/messages": {
      POST: guard(async (request: Request) => {
        try {
          authorize(request);
        } catch (error) {
          if (error instanceof RelayError) return protocolErrorResponse("anthropic", error);
          throw error;
        }
        const text = await request.text();
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(text) as Record<string, unknown>;
        } catch {
          /* The handler reports the 400 in Anthropic's envelope. */
        }
        const seed = translatedSeed(request, parsed);
        try {
          return await handleAnthropicMessages(text, request.signal, translatedDeps, seed);
        } catch (error) {
          if (error instanceof RelayError) {
            return protocolErrorResponse("anthropic", error);
          }
          throw error;
        }
      }),
    },
    "/v1/messages/count_tokens": {
      POST: guard(async (request: Request) => {
        try {
          authorize(request);
        } catch (error) {
          if (error instanceof RelayError) return protocolErrorResponse("anthropic", error);
          throw error;
        }
        const text = await request.text();
        try {
          return await handleAnthropicCountTokens(text);
        } catch (error) {
          if (error instanceof RelayError) {
            return protocolErrorResponse("anthropic", error);
          }
          throw error;
        }
      }),
    },
    "/v1/responses": {
      POST: guard(async (request: Request) => {
        authorize(request);
        const text = await request.text();
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(text) as Record<string, unknown>;
        } catch {
          /* The handler reports the 400 in the OpenAI envelope. */
        }
        const seed = translatedSeed(request, parsed);
        return handleResponses(text, request.signal, translatedDeps, seed);
      }),
    },
    "/v1/responses/:id": {
      GET: guard((request: Request) => {
        authorize(request);
        const id = (request as unknown as { params: { id: string } }).params?.id ?? "";
        // Responses are not persisted (store defaults to false), so retrieval
        // can only answer with the protocol's own not-found error.
        throw new RelayError(
          `Response '${decodeURIComponent(id)}' not found. Responses are not stored by this gateway; set store:false and keep the response client-side.`,
          404,
          "not_found",
          "invalid_request_error",
        );
      }),
    },
    "/v1/embeddings": {
      POST: guard((request) => {
        authorize(request);
        // Chat-only gateway: answer with the OpenAI error shape instead of a
        // bare 404 so clients surface a useful message.
        throw new RelayError(
          "本网关只提供 Chat Completions 与 Models 接口，不支持 embeddings。",
          404,
          "not_found",
          "invalid_request_error",
        );
      }),
    },
    "/openapi.json": { GET: guard(() => json(openApiDocument())) },
    "/docs": {
      GET: guard(
        () =>
          new Response(docsHtml(), {
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
      ),
    },
    "/": options.index ?? {
      GET: guard(() =>
        json({
          name: "OpenCode Relay",
          frontend: "未构建前端；bun run dev 会通过 HTML imports 提供页面。",
          docs: "/docs",
        }),
      ),
    },
  };

  const server = Bun.serve({
    port: settings.port,
    development: settings.development,
    maxRequestBodySize: 16 * 1024 * 1024,
    routes: routes as never,
    error(error) {
      log.error("relay.server.error", {
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        stack: error instanceof Error ? error.stack?.split("\n").slice(0, 5).join(" | ") : undefined,
      });
      return json(errorBody("服务内部错误。", "internal_error"), { status: 500 });
    },
    fetch(request) {
      // Unknown API paths get the OpenAI error envelope; anything else is a
      // plain 404. Method mismatches on known paths land here too, because
      // Bun.serve only dispatches a route whose method matches.
      const url = new URL(request.url);
      if (url.pathname.startsWith("/v1/") || url.pathname.startsWith("/api/")) {
        return json(errorBody(`Unknown request URL: ${request.method} ${url.pathname}`, "not_found", "invalid_request_error"), {
          status: 404,
        });
      }
      return new Response("Not found", { status: 404 });
    },
  });

  let stopped = false;
  return {
    server,
    store,
    upstream,
    stop() {
      if (stopped) return;
      stopped = true;
      server.stop(true);
      store.close();
    },
  };
}

function isChatModel(model: Record<string, any>): boolean {
  const api = model.api;
  return api && typeof api === "object" ? Boolean(api["chat-completions"]) : true;
}

function isFreeModel(model: Record<string, any>): boolean {
  const text = (model.cost ?? {}).text ?? {};
  const input = text.input?.price;
  const output = text.output?.price;
  return input === 0 && (output === 0 || output === undefined);
}

function openApiDocument() {
  return {
    openapi: "3.1.0",
    info: {
      title: "OpenCode Relay",
      version: "0.1.0",
      description: "OpenAI 兼容的 OpenCode Chat Completions 网关。",
    },
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
      },
    },
    paths: {
      "/v1/models": {
        get: {
          summary: "列出可用的 Chat 模型",
          parameters: [
            {
              name: "free_only",
              in: "query",
              schema: { type: "boolean" },
            },
          ],
          responses: { "200": { description: "模型列表" } },
        },
      },
      "/v1/models/{model}": {
        get: {
          summary: "获取单个模型",
          parameters: [
            { name: "model", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            "200": { description: "模型对象" },
            "404": { description: "模型不存在" },
          },
        },
      },
      "/v1/chat/completions": {
        post: {
          summary: "Chat Completions（支持 SSE 流式）",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object" } } },
          },
          responses: { "200": { description: "Chat 响应" } },
        },
      },
      "/v1/messages": {
        post: {
          summary: "Anthropic Messages（转换为 Chat 上游，支持 SSE 流式）",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object" } } },
          },
          responses: { "200": { description: "Anthropic message 对象或事件流" } },
        },
      },
      "/v1/messages/count_tokens": {
        post: {
          summary: "Anthropic 输入 token 估算",
          responses: { "200": { description: "{ input_tokens }" } },
        },
      },
      "/v1/responses": {
        post: {
          summary: "OpenAI Responses（转换为 Chat 上游，支持 SSE 事件流）",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object" } } },
          },
          responses: { "200": { description: "response 对象或事件流" } },
        },
      },
      "/v1/responses/{response_id}": {
        get: {
          summary: "读取已存储的 response（本网关不存储，返回 404）",
          parameters: [
            { name: "response_id", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: { "404": { description: "not_found" } },
        },
      },
      "/v1/embeddings": {
        post: {
          summary: "不支持（仅 Chat 网关）",
          responses: { "404": { description: "not_found" } },
        },
      },
      "/api/health": {
        get: { summary: "健康检查", security: [], responses: { "200": { description: "ok" } } },
      },
    },
  };
}

function docsHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>OpenCode Relay · API</title>
<style>
  body { font-family: ui-sans-serif, system-ui, sans-serif; max-width: 760px; margin: 48px auto; padding: 0 20px; color: #131416; line-height: 1.7; }
  code, pre { font-family: ui-monospace, Consolas, monospace; background: #f4f6f8; border-radius: 6px; }
  code { padding: 2px 6px; }
  pre { padding: 16px; overflow: auto; }
  h1 { font-size: 24px; } h2 { margin-top: 32px; font-size: 16px; }
  a { color: #1b6c80; }
</style>
</head>
<body>
<h1>OpenCode Relay API</h1>
<p>OpenAI 兼容接口。请求头使用设置页生成的调用密钥：</p>
<pre>Authorization: Bearer sk-relay-…</pre>
<h2>端点</h2>
<ul>
  <li><code>GET /v1/models</code> — 模型列表，可用 <code>?free_only=true</code> 只看免费模型。</li>
  <li><code>POST /v1/chat/completions</code> — Chat 请求，<code>stream: true</code> 开启 SSE。</li>
  <li><code>GET /api/health</code> — 健康检查。</li>
</ul>
<h2>示例</h2>
<pre>curl http://127.0.0.1:8948/v1/chat/completions \\
  -H "Authorization: Bearer YOUR_RELAY_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"MODEL_ID","messages":[{"role":"user","content":"你好"}],"stream":true}'</pre>
<p><a href="/openapi.json">OpenAPI JSON</a></p>
</body>
</html>`;
}
