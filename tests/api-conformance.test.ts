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

/** OpenAI error envelope: { error: { message, type, param, code } }. */
function expectOpenAiError(body: any, type?: string) {
  expect(body).toBeTruthy();
  expect(typeof body.error).toBe("object");
  expect(typeof body.error.message).toBe("string");
  expect(body.error.message.length).toBeGreaterThan(0);
  expect(typeof body.error.type).toBe("string");
  expect("param" in body.error).toBe(true);
  expect("code" in body.error).toBe(true);
  if (type) expect(body.error.type).toBe(type);
}

describe("OpenAI API conformance: GET /v1/models", () => {
  test("returns the list envelope with OpenAI model objects", async () => {
    const response = await browser.get("/v1/models");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = await response.json();
    expect(body.object).toBe("list");
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
    for (const model of body.data) {
      expect(typeof model.id).toBe("string");
      expect(model.id.length).toBeGreaterThan(0);
      expect(model.object).toBe("model");
      expect(typeof model.created).toBe("number");
      expect(Number.isInteger(model.created)).toBe(true);
      expect(typeof model.owned_by).toBe("string");
      expect(typeof model.is_free).toBe("boolean");
    }
  });

  test("lists only chat-completions models", async () => {
    const ids = (await (await browser.get("/v1/models")).json()).data.map(
      (model: { id: string }) => model.id,
    );
    expect(ids).toEqual(["free-model", "paid-model"]);
    expect(ids).not.toContain("image-only");
    expect(ids).not.toContain("anthropic-only");
    expect(ids).not.toContain("systemone-only");
  });

  test("free_only accepts 1/true/yes in any case and rejects other values", async () => {
    for (const value of ["1", "true", "TRUE", "yes", "Yes"]) {
      const body = await (await browser.get(`/v1/models?free_only=${value}`)).json();
      expect(body.data.map((model: { id: string }) => model.id)).toEqual(["free-model"]);
    }
    for (const value of ["0", "false", "no", ""]) {
      const body = await (await browser.get(`/v1/models?free_only=${value}`)).json();
      expect(body.data).toHaveLength(2);
    }
  });

  test("requires bearer auth and marks 401 responses", async () => {
    const anonymous = startApp({ opencodeBaseUrl: upstream.url, relayApiKey: "relay-key" });
    try {
      const client = new Browser(anonymous);
      const response = await client.get("/v1/models");
      expect(response.status).toBe(401);
      expect(response.headers.get("x-relay-auth-error")).toBe("1");
      expectOpenAiError(await response.json());
    } finally {
      anonymous.stop();
    }
  });
});

describe("OpenAI API conformance: GET /v1/models/{id}", () => {
  test("returns one model object", async () => {
    const response = await browser.get("/v1/models/free-model");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.id).toBe("free-model");
    expect(body.object).toBe("model");
    expect(body.is_free).toBe(true);
    expect(typeof body.created).toBe("number");
    expect(typeof body.owned_by).toBe("string");
  });

  test("unknown model is a 404 with the OpenAI error shape", async () => {
    const response = await browser.get("/v1/models/does-not-exist");
    expect(response.status).toBe(404);
    expectOpenAiError(await response.json(), "invalid_request_error");
  });

  test("non-chat models are not addressable", async () => {
    expect((await browser.get("/v1/models/image-only")).status).toBe(404);
    expect((await browser.get("/v1/models/anthropic-only")).status).toBe(404);
  });
});

describe("OpenAI API conformance: POST /v1/chat/completions", () => {
  test("non-stream response matches the chat.completion schema", async () => {
    const response = await browser.post("/v1/chat/completions", {
      model: "free-model",
      messages: [{ role: "user", content: "你好" }],
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = await response.json();
    expect(body.object).toBe("chat.completion");
    expect(typeof body.id).toBe("string");
    expect(typeof body.created).toBe("number");
    expect(body.model).toBe("free-model");
    expect(Array.isArray(body.choices)).toBe(true);
    const choice = body.choices[0];
    expect(choice.index).toBe(0);
    expect(choice.message.role).toBe("assistant");
    expect(typeof choice.message.content).toBe("string");
    expect(choice.finish_reason).toBe("stop");
    expect(typeof body.usage).toBe("object");
    for (const field of ["prompt_tokens", "completion_tokens", "total_tokens"]) {
      expect(typeof body.usage[field]).toBe("number");
    }
  });

  test("stream response is SSE with chunk envelopes and a final [DONE]", async () => {
    const response = await browser.post("/v1/chat/completions", {
      model: "free-model",
      messages: [{ role: "user", content: "你好" }],
      stream: true,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toStartWith("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    const text = await response.text();
    const frames = text
      .split("\n\n")
      .map((frame) => frame.trim())
      .filter(Boolean);
    expect(frames.at(-1)).toBe("data: [DONE]");
    const payloads = frames
      .slice(0, -1)
      .filter((frame) => frame.startsWith("data: "))
      .map((frame) => JSON.parse(frame.slice("data: ".length)));
    expect(payloads.length).toBeGreaterThan(0);
    for (const chunk of payloads) {
      expect(chunk.object).toBe("chat.completion.chunk");
      expect(typeof chunk.id).toBe("string");
      expect(typeof chunk.created).toBe("number");
      expect(chunk.model).toBe("free-model");
      expect(Array.isArray(chunk.choices)).toBe(true);
      for (const choice of chunk.choices) {
        expect(typeof choice.index).toBe("number");
        expect(typeof choice.delta).toBe("object");
        expect("finish_reason" in choice).toBe(true);
      }
    }
    const content = payloads
      .map((chunk) => chunk.choices[0]?.delta?.content ?? "")
      .join("");
    expect(content).toBe("你好，Bun！");
    const usage = payloads.find((chunk) => chunk.usage);
    expect(usage.usage.total_tokens).toBe(8);
  });

  test("stream:false is honoured even though the upstream is streamed", async () => {
    const response = await browser.post("/v1/chat/completions", {
      model: "free-model",
      messages: [{ role: "user", content: "你好" }],
      stream: false,
    });
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = await response.json();
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0].message.content).toBe("你好，Bun！");
  });

  test("tool_calls follow the OpenAI shape and caller names are restored", async () => {
    const response = await browser.post("/v1/chat/completions", {
      model: "echo-tool",
      messages: [{ role: "user", content: "run it" }],
      tools: [
        {
          type: "function",
          function: {
            name: "RunShell",
            description: "Run a shell command",
            parameters: {
              type: "object",
              properties: { command: { type: "string" } },
              required: ["command"],
            },
          },
        },
      ],
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    const choice = body.choices[0];
    expect(choice.finish_reason).toBe("tool_calls");
    expect(Array.isArray(choice.message.tool_calls)).toBe(true);
    const call = choice.message.tool_calls[0];
    expect(call.type).toBe("function");
    expect(typeof call.id).toBe("string");
    expect(call.function.name).toBe("RunShell");
    expect(() => JSON.parse(call.function.arguments)).not.toThrow();
  });

  test("reasoning_content survives aggregation", async () => {
    const body = await (
      await browser.post("/v1/chat/completions", {
        model: "free-model",
        messages: [{ role: "user", content: "你好" }],
      })
    ).json();
    expect(body.choices[0].message.reasoning_content).toBe("思考");
  });

  test("sampling parameters are forwarded, not dropped", async () => {
    await browser.post("/v1/chat/completions", {
      model: "free-model",
      messages: [{ role: "user", content: "你好" }],
      temperature: 0.2,
      top_p: 0.9,
      stop: ["\n\n"],
      seed: 42,
      user: "conformance",
      presence_penalty: 0.1,
      frequency_penalty: 0.1,
      response_format: { type: "text" },
      n: 1,
    });
    const wire = upstream.requests.at(-1)!.body;
    expect(wire.temperature).toBe(0.2);
    expect(wire.top_p).toBe(0.9);
    expect(wire.stop).toEqual(["\n\n"]);
    expect(wire.seed).toBe(42);
    expect(wire.user).toBe("conformance");
    expect(wire.presence_penalty).toBe(0.1);
    expect(wire.frequency_penalty).toBe(0.1);
    expect(wire.response_format).toEqual({ type: "text" });
    expect(wire.n).toBe(1);
    // Relay-owned fields are still normalized.
    expect(wire.stream).toBe(true);
    expect(wire.stream_options.include_usage).toBe(true);
    expect(wire.max_completion_tokens).toBe(32000);
  });

  test("multi-turn history and tool results pass through", async () => {
    await browser.post("/v1/chat/completions", {
      model: "free-model",
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "read a.txt" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "Read", arguments: '{"file_path":"a.txt"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "hello" },
        { role: "user", content: "summarize" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "Read",
            description: "Read a file",
            parameters: { type: "object", properties: { file_path: { type: "string" } } },
          },
        },
      ],
    });
    const wire = upstream.requests.at(-1)!.body;
    const roles = wire.messages.map((message: { role: string }) => message.role);
    expect(roles).toEqual(["system", "user", "assistant", "tool", "user"]);
    const assistant = wire.messages[2];
    expect(assistant.tool_calls).toHaveLength(1);
    expect(assistant.tool_calls[0].function.name).toMatch(/^mcp_/);
    const tool = wire.messages[3];
    expect(tool.tool_call_id).toBe("call_1");
    expect(tool.content).toBe("hello");
  });
});

describe("OpenAI API conformance: errors", () => {
  test("invalid JSON is a 400 invalid_request_error", async () => {
    const response = await browser.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(response.status).toBe(400);
    expectOpenAiError(await response.json(), "invalid_request_error");
  });

  test("schema violations are 400 and name every problem", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{}, "model"],
      [{ model: "x" }, "messages"],
      [{ model: "x", messages: [] }, "messages"],
      [{ model: "", messages: [{ role: "user", content: "hi" }] }, "model"],
      [{ model: "x".repeat(257), messages: [{ role: "user", content: "hi" }] }, "model"],
      [{ model: "x", messages: [{ role: "wizard", content: "hi" }] }, "role"],
      [{ model: "x", messages: [{ role: "user", content: 42 }] }, "content"],
      [{ model: "x", messages: [{ role: "user", content: "hi" }], stream: "yes" }, "stream"],
      [{ model: "x", messages: [{ role: "user", content: "hi" }], max_tokens: 0 }, "max_tokens"],
      [
        { model: "x", messages: [{ role: "user", content: "hi" }], max_completion_tokens: -1 },
        "max_completion_tokens",
      ],
    ];
    for (const [payload, field] of cases) {
      const response = await browser.post("/v1/chat/completions", payload);
      expect(response.status).toBe(400);
      const body = await response.json();
      expectOpenAiError(body, "invalid_request_error");
      expect(body.error.message).toContain(field);
    }
  });

  test("upstream errors keep their status and OpenAI envelope", async () => {
    const limited = await browser.post("/v1/chat/completions", {
      model: "rate-limit",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("7");
    expectOpenAiError(await limited.json());

    const html = await browser.post("/v1/chat/completions", {
      model: "html-error",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(html.status).toBe(502);
    expectOpenAiError(await html.json());
  });

  test("unknown /v1 paths and wrong methods get the OpenAI error envelope", async () => {
    const unknown = await browser.get("/v1/nope");
    expect(unknown.status).toBe(404);
    expectOpenAiError(await unknown.json(), "invalid_request_error");

    const wrongMethod = await browser.get("/v1/chat/completions");
    expect(wrongMethod.status).toBe(404);
    expectOpenAiError(await wrongMethod.json(), "invalid_request_error");

    const embeddings = await browser.post("/v1/embeddings", { input: "x", model: "free-model" });
    expect(embeddings.status).toBe(404);
    expectOpenAiError(await embeddings.json(), "invalid_request_error");
  });

  test("embeddings requires auth before the 404", async () => {
    const anonymous = startApp({ opencodeBaseUrl: upstream.url, relayApiKey: "relay-key" });
    try {
      const response = await new Browser(anonymous).post("/v1/embeddings", { input: "x" });
      expect(response.status).toBe(401);
    } finally {
      anonymous.stop();
    }
  });
});

describe("OpenAPI document", () => {
  test("documents every public route", async () => {
    const response = await browser.get("/openapi.json");
    expect(response.status).toBe(200);
    const doc = await response.json();
    expect(doc.openapi).toMatch(/^3\./);
    expect(doc.info.title).toBe("OpenCode Relay");
    for (const path of [
      "/v1/models",
      "/v1/models/{model}",
      "/v1/chat/completions",
      "/v1/embeddings",
      "/api/health",
    ]) {
      expect(doc.paths[path]).toBeTruthy();
    }
    expect(doc.components.securitySchemes.bearerAuth.scheme).toBe("bearer");
  });

  test("docs page is served as HTML", async () => {
    const response = await browser.get("/docs");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("OpenCode Relay API");
  });
});
