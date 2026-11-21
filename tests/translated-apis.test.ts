import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";

import { Browser, startApp, type TestApp } from "./helpers";
import { startUpstream } from "./upstream";

const upstream = startUpstream();
let app: TestApp;
let browser: Browser;

beforeEach(async () => {
  upstream.reset();
  app = startApp({ opencodeBaseUrl: upstream.url, opencodeApiKey: "test-key" });
  browser = new Browser(app);
  expect((await browser.post("/api/session", {})).status).toBe(200);
});

afterEach(() => app.stop());
afterAll(() => upstream.stop());

function anthropicError(body: any): void {
  expect(body.type).toBe("error");
  expect(typeof body.error).toBe("object");
  expect(typeof body.error.type).toBe("string");
  expect(typeof body.error.message).toBe("string");
}

async function sseEvents(response: Response): Promise<{ event: string; data: any }[]> {
  const text = await response.text();
  // Frames may be separated by "\n\n" or "\r\n\r\n" depending on the encoder.
  return text
    .split(/\r?\n\r?\n/)
    .map((frame) => frame.trim())
    .filter(Boolean)
    .map((frame) => {
      const lines = frame.split(/\r?\n/);
      const event = lines.find((line) => line.startsWith("event: "))?.slice(7) ?? "";
      const data = lines.find((line) => line.startsWith("data: "))?.slice(6) ?? "";
      let parsed: any = data;
      try {
        parsed = JSON.parse(data);
      } catch {
        /* keep the raw string */
      }
      return { event, data: parsed };
    });
}

describe("Anthropic Messages: POST /v1/messages", () => {
  const baseRequest = {
    model: "free-model",
    max_tokens: 64,
    messages: [{ role: "user", content: "你好" }],
  };

  test("non-stream returns a message object with the Anthropic schema", async () => {
    const response = await browser.post("/v1/messages", baseRequest);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = await response.json();
    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");
    expect(typeof body.id).toBe("string");
    expect(body.id).toStartWith("msg_");
    expect(body.model).toBe("free-model");
    expect(Array.isArray(body.content)).toBe(true);
    const text = body.content.find((block: { type: string }) => block.type === "text");
    expect(text.text).toBe("你好，Bun！");
    expect(body.stop_reason).toBe("end_turn");
    expect(body.stop_sequence).toBeNull();
    expect(typeof body.usage.input_tokens).toBe("number");
    expect(typeof body.usage.output_tokens).toBe("number");
  });

  test("system, tool definitions and tool_choice are translated onto the wire", async () => {
    await browser.post("/v1/messages", {
      ...baseRequest,
      system: "be brief",
      tools: [
        {
          name: "Read",
          description: "Read a file",
          input_schema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      ],
      tool_choice: { type: "auto" },
    });
    const wire = upstream.requests.at(-1)!.body;
    expect(wire.messages[0].role).toBe("system");
    expect(wire.messages[0].content).toContain("be brief");
    expect(wire.messages[0].content).toContain("<env>");
    const names = wire.tools.map((tool: any) => tool.function.name);
    expect(names).toContain("read");
    expect(wire.tool_choice).toBe("auto");
    expect(wire.max_completion_tokens).toBe(64);
  });

  test("tool_result blocks become tool messages and tool_use becomes tool_calls", async () => {
    await browser.post("/v1/messages", {
      ...baseRequest,
      tools: [
        {
          name: "Read",
          input_schema: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
      messages: [
        { role: "user", content: "read a.txt" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "reading" },
            { type: "tool_use", id: "toolu_1", name: "Read", input: { path: "a.txt" } },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "hello" }],
        },
      ],
    });
    const wire = upstream.requests.at(-1)!.body;
    const assistant = wire.messages.find((message: any) => message.role === "assistant");
    expect(assistant.tool_calls[0].function.name).toMatch(/^mcp_/);
    expect(JSON.parse(assistant.tool_calls[0].function.arguments)).toEqual({ path: "a.txt" });
    const tool = wire.messages.find((message: any) => message.role === "tool");
    expect(tool.tool_call_id).toBe("toolu_1");
    expect(tool.content).toBe("hello");
  });

  test("stream emits the Anthropic event sequence", async () => {
    const response = await browser.post("/v1/messages", { ...baseRequest, stream: true });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toStartWith("text/event-stream");
    const events = await sseEvents(response);
    const types = events.map((event) => event.event);
    expect(types[0]).toBe("message_start");
    expect(types).toContain("content_block_start");
    expect(types).toContain("content_block_delta");
    expect(types).toContain("content_block_stop");
    expect(types).toContain("message_delta");
    expect(types.at(-1)).toBe("message_stop");

    const start = events.find((event) => event.event === "message_start")!;
    expect(start.data.type).toBe("message_start");
    expect(start.data.message.role).toBe("assistant");
    expect(start.data.message.content).toEqual([]);

    const deltas = events
      .filter((event) => event.event === "content_block_delta")
      .map((event) => event.data.delta)
      .filter((delta: any) => delta.type === "text_delta")
      .map((delta: any) => delta.text)
      .join("");
    expect(deltas).toBe("你好，Bun！");

    const delta = events.find((event) => event.event === "message_delta")!;
    expect(delta.data.delta.stop_reason).toBe("end_turn");
    expect(delta.data.usage.output_tokens).toBe(5);
  });

  test("streamed tool calls use tool_use blocks with input_json_delta", async () => {
    const response = await browser.post("/v1/messages", {
      ...baseRequest,
      model: "echo-tool",
      stream: true,
      tools: [
        {
          name: "RunShell",
          description: "Run a shell command",
          input_schema: { type: "object", properties: { command: { type: "string" } } },
        },
      ],
      messages: [{ role: "user", content: "run it" }],
    });
    const events = await sseEvents(response);
    const start = events.find(
      (event) => event.event === "content_block_start" && event.data.content_block?.type === "tool_use",
    )!;
    expect(start.data.content_block.name).toBe("RunShell");
    expect(start.data.content_block.input).toEqual({});
    const partial = events
      .filter((event) => event.event === "content_block_delta" && event.data.delta?.type === "input_json_delta")
      .map((event) => event.data.delta.partial_json)
      .join("");
    expect(JSON.parse(partial)).toEqual({});
    const delta = events.find((event) => event.event === "message_delta")!;
    expect(delta.data.delta.stop_reason).toBe("tool_use");
  });

  test("validation errors use the Anthropic envelope", async () => {
    for (const payload of [
      {},
      { model: "x", max_tokens: 10 },
      { model: "x", max_tokens: 0, messages: [{ role: "user", content: "hi" }] },
    ]) {
      const response = await browser.post("/v1/messages", payload);
      expect(response.status).toBe(400);
      anthropicError(await response.json());
    }
    const invalid = await browser.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{oops",
    });
    expect(invalid.status).toBe(400);
    anthropicError(await invalid.json());
  });

  test("auth failures use the Anthropic envelope", async () => {
    const anonymous = startApp({ opencodeBaseUrl: upstream.url, relayApiKey: "relay-key" });
    try {
      const response = await new Browser(anonymous).post("/v1/messages", baseRequest);
      expect(response.status).toBe(401);
      const body = await response.json();
      // The route wrapper reports auth failures in the Anthropic envelope.
      expect(body.error.type).toBe("authentication_error");
      expect(typeof body.error.message).toBe("string");
    } finally {
      anonymous.stop();
    }
  });

  test("upstream failures keep status and use the Anthropic envelope", async () => {
    const limited = await browser.post("/v1/messages", {
      ...baseRequest,
      model: "rate-limit",
    });
    expect(limited.status).toBe(429);
    const body = await limited.json();
    anthropicError(body);
    expect(body.error.type).toBe("rate_limit_error");
    expect(limited.headers.get("retry-after")).toBe("7");
  });

  test("POST /v1/messages/count_tokens returns input_tokens", async () => {
    const response = await browser.post("/v1/messages/count_tokens", {
      model: "free-model",
      messages: [{ role: "user", content: "hello world" }],
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(typeof body.input_tokens).toBe("number");
    expect(body.input_tokens).toBeGreaterThan(0);
  });
});

describe("OpenAI Responses: POST /v1/responses", () => {
  const baseRequest = {
    model: "free-model",
    input: "你好",
  };

  test("non-stream returns a response object with the Responses schema", async () => {
    const response = await browser.post("/v1/responses", baseRequest);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.object).toBe("response");
    expect(typeof body.id).toBe("string");
    expect(body.id).toStartWith("resp_");
    expect(body.status).toBe("completed");
    expect(body.error).toBeNull();
    expect(body.model).toBe("free-model");
    expect(Array.isArray(body.output)).toBe(true);
    const message = body.output.find((item: { type: string }) => item.type === "message");
    expect(message.role).toBe("assistant");
    expect(message.content[0].type).toBe("output_text");
    expect(message.content[0].text).toBe("你好，Bun！");
    expect(body.output_text).toBe("你好，Bun！");
    expect(typeof body.created_at).toBe("number");
    expect(body.usage.input_tokens).toBe(3);
    expect(body.usage.output_tokens).toBe(5);
    expect(body.usage.total_tokens).toBe(8);
    expect(body.usage.input_tokens_details).toEqual({ cached_tokens: 0 });
    expect(body.store).toBe(false);
  });

  test("instructions and input arrays are translated", async () => {
    await browser.post("/v1/responses", {
      model: "free-model",
      instructions: "be brief",
      input: [
        { role: "user", content: [{ type: "input_text", text: "你好" }] },
      ],
    });
    const wire = upstream.requests.at(-1)!.body;
    expect(wire.messages[0].role).toBe("system");
    expect(wire.messages[0].content).toContain("be brief");
    expect(wire.messages[1].content).toBe("你好");
  });

  test("function tools and function_call history are translated", async () => {
    await browser.post("/v1/responses", {
      model: "free-model",
      tools: [
        {
          type: "function",
          name: "Read",
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
      input: [
        { role: "user", content: "read a.txt" },
        { type: "function_call", call_id: "call_1", name: "Read", arguments: '{"path":"a.txt"}' },
        { type: "function_call_output", call_id: "call_1", output: "hello" },
      ],
    });
    const wire = upstream.requests.at(-1)!.body;
    const names = wire.tools.map((tool: any) => tool.function.name);
    expect(names).toContain("read");
    const assistant = wire.messages.find((message: any) => message.role === "assistant");
    expect(assistant.tool_calls[0].function.name).toMatch(/^mcp_/);
    const tool = wire.messages.find((message: any) => message.role === "tool");
    expect(tool.tool_call_id).toBe("call_1");
    expect(tool.content).toBe("hello");
  });

  test("function calls are reported as function_call output items", async () => {
    const response = await browser.post("/v1/responses", {
      model: "echo-tool",
      input: "run it",
      tools: [
        {
          type: "function",
          name: "RunShell",
          parameters: { type: "object", properties: { command: { type: "string" } } },
        },
      ],
    });
    const body = await response.json();
    const call = body.output.find((item: { type: string }) => item.type === "function_call");
    expect(call).toBeTruthy();
    expect(call.name).toBe("RunShell");
    expect(typeof call.call_id).toBe("string");
    expect(JSON.parse(call.arguments)).toEqual({});
  });

  test("stream emits the Responses event sequence", async () => {
    const response = await browser.post("/v1/responses", { ...baseRequest, stream: true });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toStartWith("text/event-stream");
    const events = await sseEvents(response);
    const types = events.map((event) => event.event);
    expect(types[0]).toBe("response.created");
    expect(types).toContain("response.output_item.added");
    expect(types).toContain("response.output_text.delta");
    expect(types).toContain("response.output_text.done");
    expect(types.at(-1)).toBe("response.completed");
    for (const event of events) {
      expect(typeof event.data.sequence_number).toBe("number");
    }
    const text = events
      .filter((event) => event.event === "response.output_text.delta")
      .map((event) => event.data.delta)
      .join("");
    expect(text).toBe("你好，Bun！");
    const completed = events.at(-1)!.data.response;
    expect(completed.object).toBe("response");
    expect(completed.status).toBe("completed");
    expect(completed.output_text).toBe("你好，Bun！");
    expect(completed.usage.total_tokens).toBe(8);
  });

  test("validation errors use the OpenAI envelope", async () => {
    const response = await browser.post("/v1/responses", { input: "hi" });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toContain("model");
  });

  test("GET /v1/responses/{id} answers 404 in the OpenAI envelope", async () => {
    const response = await browser.get("/v1/responses/resp_unknown");
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe("not_found");
  });
});
