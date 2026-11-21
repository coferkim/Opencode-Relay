export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: any;
  aborted: boolean;
  streamCancelled: boolean;
}

export interface MockUpstream {
  url: string;
  requests: RecordedRequest[];
  readonly retryOnceCount: number;
  reset(): void;
  stop(): void;
}

const CATALOG = {
  data: [
    {
      id: "free-model",
      object: "model",
      created: 1795250318,
      owned_by: "opencode",
      name: "Free",
      api: { "chat-completions": { path: "chat" } },
      cost: { text: { input: { price: 0 }, output: { price: 0 } } },
      limit: { context: 200000, output: 32000 },
    },
    {
      id: "paid-model",
      object: "model",
      created: 1795250318,
      owned_by: "opencode",
      name: "Paid",
      api: { "chat-completions": { path: "chat" } },
      cost: { text: { input: { price: 1 }, output: { price: 2 } } },
      limit: { context: 200000, output: 32000 },
    },
    { id: "image-only", api: { images: { path: "images" } } },
    { id: "anthropic-only", api: { messages: { base_url: "https://example.invalid/anthropic" } } },
    { id: "systemone-only", api: { systemone: { base_url: "https://example.invalid/systemone" } } },
  ],
};

function chunkEvents(model: string, deltas: Record<string, unknown>[], finish: string) {
  const events: Record<string, unknown>[] = deltas.map((delta) => ({
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [{ index: 0, delta, finish_reason: null, logprobs: null }],
  }));
  events.push({
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: finish, logprobs: null }],
  });
  events.push({
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [],
    usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
  });
  return events;
}

function sse(events: Record<string, unknown>[], options: { truncated?: boolean } = {}) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(": heartbeat\r\n\r\n"));
      const sent = options.truncated ? events.slice(0, 1) : events;
      for (const event of sent) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\r\n\r\n`),
        );
      }
      if (!options.truncated) controller.enqueue(encoder.encode("data: [DONE]\r\n\r\n"));
      controller.close();
    },
  });
}

function slowStream(
  record: RecordedRequest,
  events: Record<string, unknown>[],
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode(": heartbeat\r\n\r\n"));
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(events[0])}\r\n\r\n`),
        );
        await Bun.sleep(2000);
        if (record.aborted) return;
        controller.enqueue(encoder.encode("data: [DONE]\r\n\r\n"));
        controller.close();
      } catch {
        /* Client went away while queued. */
      }
    },
    cancel() {
      record.streamCancelled = true;
    },
  });
}

export function startUpstream(): MockUpstream {
  const requests: RecordedRequest[] = [];
  let retryOnce = 0;

  const reply = (
    status: number,
    body: string,
    contentType = "application/json",
    headers: Record<string, string> = {},
  ) => new Response(body, { status, headers: { "content-type": contentType, ...headers } });

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const headers = Object.fromEntries(request.headers.entries());
      const record: RecordedRequest = {
        method: request.method,
        path: url.pathname,
        headers,
        body: null,
        aborted: false,
        streamCancelled: false,
      };
      request.signal.addEventListener("abort", () => {
        record.aborted = true;
      });

      if (request.method === "GET" && url.pathname === "/models") {
        requests.push(record);
        return reply(200, JSON.stringify(CATALOG));
      }

      if (request.method !== "POST" || url.pathname !== "/chat/completions") {
        return reply(404, "{}");
      }

      const body = await request.json();
      record.body = body;
      requests.push(record);
      const model = body.model as string;

      if (model === "slow-headers") {
        await Bun.sleep(2000);
        if (record.aborted) return new Response(null, { status: 499 });
      }

      if (model === "retry-once") {
        retryOnce += 1;
        if (retryOnce === 1) {
          return reply(
            429,
            '{"error":{"message":"session quota","type":"rate_limit_error"}}',
          );
        }
      }
      if (model === "unauthorized") {
        return reply(
          401,
          '{"error":{"message":"Invalid upstream credential","type":"authentication_error"}}',
          "application/json",
          { "x-relay-auth-error": "1" },
        );
      }
      if (model === "rate-limit") {
        return reply(
          429,
          '{"error":{"message":"quota exceeded","type":"rate_limit_error"}}',
          "application/json",
          { "retry-after": "7" },
        );
      }
      if (model === "html-error") {
        return reply(502, "upstream unavailable", "text/html");
      }

      let deltas: Record<string, unknown>[];
      let finish = "stop";
      if (model === "tool-model") {
        deltas = [
          {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: { name: "read", arguments: '{"path":' },
              },
            ],
          },
          {
            tool_calls: [
              { index: 0, function: { arguments: '"test.txt"}' } },
            ],
          },
        ];
        finish = "tool_calls";
      } else if (model === "echo-tool") {
        // Echo the first opaque client tool the relay declared, the way a real
        // model would call one of the caller's tools.
        const wire = (Array.isArray(body.tools) ? body.tools : [])
          .map((tool: any) => tool?.function?.name ?? tool?.name ?? "")
          .find((name: string) => name.startsWith("mcp_"));
        deltas = [
          {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call_2",
                type: "function",
                function: { name: wire ?? "tool_0", arguments: "{}" },
              },
            ],
          },
        ];
        finish = "tool_calls";
      } else {
        deltas = [
          { role: "assistant", reasoning_content: "思考" },
          { content: "你好" },
          { content: "，Bun！" },
        ];
        if (model === "length-model") finish = "length";
      }

      const events = chunkEvents(model, deltas, finish);
      const streamHeaders = {
        "x-zen-model": model,
        "x-opencode-log-id": "test-log-id",
      };

      if (model === "slow-stream") {
        return new Response(slowStream(record, events), {
          headers: { "content-type": "text/event-stream", ...streamHeaders },
        });
      }
      return new Response(
        sse(events, { truncated: model === "truncated" }),
        { headers: { "content-type": "text/event-stream", ...streamHeaders } },
      );
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    get retryOnceCount() {
      return retryOnce;
    },
    reset() {
      requests.length = 0;
      retryOnce = 0;
    },
    stop() {
      server.stop(true);
    },
  };
}
