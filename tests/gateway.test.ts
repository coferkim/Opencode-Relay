import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  Browser,
  chatBody,
  startApp,
  waitFor,
  type TestApp,
} from "./helpers";
import { startUpstream } from "./upstream";

const upstream = startUpstream();
let app: TestApp;
let browser: Browser;

function lowerHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
}

beforeEach(async () => {
  upstream.reset();
  app = startApp({
    opencodeBaseUrl: upstream.url,
    opencodeApiKey: "test-key",
  });
  browser = new Browser(app);
  expect((await browser.post("/api/session", {})).status).toBe(200);
});

afterEach(() => app.stop());
afterAll(() => upstream.stop());

describe("gateway", () => {
  test("live catalog filters non-chat models", async () => {
    const response = await browser.get("/v1/models");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.map((model: { id: string }) => model.id)).toEqual([
      "free-model",
      "paid-model",
    ]);
    expect(body.data[0].is_free).toBe(true);
    const free = await browser.get("/v1/models?free_only=true");
    expect(free.status).toBe(200);
    expect((await free.json()).data.map((model: { id: string }) => model.id)).toEqual([
      "free-model",
    ]);
  });

  test("non-stream aggregation and native request", async () => {
    const response = await browser.post("/v1/chat/completions", chatBody());
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.object).toBe("chat.completion");
    expect(result.choices[0].message.content).toBe("你好，Bun！");
    expect(result.choices[0].message.reasoning_content).toBe("思考");
    expect(result.usage.total_tokens).toBe(8);
    expect(response.headers.get("x-zen-model")).toBe("free-model");

    const request = upstream.requests.at(-1)!;
    const body = request.body;
    expect(body.stream).toBe(true);
    expect(body.stream_options.include_usage).toBe(true);
    expect(body.max_completion_tokens).toBe(32);
    expect(body.max_tokens).toBeUndefined();
    expect(body.messages[0].content).toContain("Working directory:");
    expect(
      body.tools.some(
        (tool: { function?: { name?: string } }) => tool.function?.name === "read",
      ),
    ).toBe(true);
    const headers = lowerHeaders(request.headers);
    expect(headers.authorization).toBe("Bearer test-key");
    expect(headers["x-opencode-client"]).toBe("cli");
    expect(headers["user-agent"]).toBe("opencode/latest/2.1.1/cli");
    expect(headers["x-opencode-session"]).toBe(headers["x-session-affinity"]);
    expect(headers["x-opencode-session-id"]).toBe(headers["x-opencode-session"]);
    expect(headers["x-opencode-request"]).toBeUndefined();
    // No explicit accept is set; Bun's fetch default (`*/*`) is what the
    // official Bun-based client also puts on the wire.
    expect(headers.accept).toBe("*/*");
    expect(headers["x-opencode-project"]).toMatch(/^[0-9a-f]{40}$/);
  });

  test("tool loops reuse the upstream identity", async () => {
    const tool = {
      type: "function",
      function: { name: "read", description: "Read a file", parameters: {} },
    };
    await browser.post("/v1/chat/completions", { ...chatBody(), tools: [tool] });
    const first = lowerHeaders(upstream.requests.at(-1)!.headers);

    const second = {
      ...chatBody(),
      tools: [tool],
      messages: [
        { role: "user", content: "你好" },
        { role: "assistant", content: "earlier reply" },
        { role: "user", content: "follow-up" },
      ],
    };
    await browser.post("/v1/chat/completions", second);
    const again = lowerHeaders(upstream.requests.at(-1)!.headers);
    expect(again["x-opencode-session"]).toBe(first["x-opencode-session"]);
    expect(again["x-opencode-project"]).toBe(first["x-opencode-project"]);

    const changed = {
      ...chatBody(),
      tools: [tool],
      messages: [{ role: "user", content: "different conversation" }],
    };
    await browser.post("/v1/chat/completions", changed);
    const other = lowerHeaders(upstream.requests.at(-1)!.headers);
    expect(other["x-opencode-session"]).not.toBe(first["x-opencode-session"]);
  });

  test("one-shot requests get a fresh upstream identity", async () => {
    const headers = { "x-opencode-session": "ses_00000000000000000000000000" };
    await browser.post("/v1/chat/completions", chatBody(), { headers });
    const first = lowerHeaders(upstream.requests.at(-1)!.headers);
    await browser.post("/v1/chat/completions", chatBody(), { headers });
    const second = lowerHeaders(upstream.requests.at(-1)!.headers);
    expect(first["x-opencode-session"]).not.toBe(second["x-opencode-session"]);
  });

  test("stream is forwarded with done and usage", async () => {
    const response = await browser.post("/v1/chat/completions", chatBody("free-model", true));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toStartWith("text/event-stream");
    const text = await response.text();
    expect(text).toContain("data: [DONE]");
    expect(text).toContain("completion_tokens");
    expect(text).toContain("你好");
  });

  test("tool calls and finish reasons are preserved", async () => {
    const toolResult = await (
      await browser.post("/v1/chat/completions", chatBody("tool-model"))
    ).json();
    const choice = toolResult.choices[0];
    expect(choice.finish_reason).toBe("tool_calls");
    expect(choice.message.tool_calls[0].id).toBe("call_1");
    expect(choice.message.tool_calls[0].function).toEqual({
      name: "read",
      arguments: '{"path":"test.txt"}',
    });

    const lengthResult = await (
      await browser.post("/v1/chat/completions", chatBody("length-model"))
    ).json();
    expect(lengthResult.choices[0].finish_reason).toBe("length");
  });

  test("caller tool names are masked on the wire and restored in responses", async () => {
    const tool = {
      type: "function",
      function: { name: "pwsh", description: "Run shell", parameters: {} },
    };
    const result = await (
      await browser.post("/v1/chat/completions", {
        ...chatBody("echo-tool"),
        tools: [tool],
      })
    ).json();
    expect(result.choices[0].message.tool_calls[0].function.name).toBe("pwsh");

    const wire = upstream.requests.at(-1)!.body;
    const names = wire.tools.map(
      (item: { function?: { name?: string }; name?: string }) =>
        item.function?.name ?? item.name,
    );
    expect(names.filter((name: string) => name.startsWith("mcp_"))).toHaveLength(1);
    expect(names).toEqual(
      expect.arrayContaining([
        "edit", "execute", "glob", "grep", "question", "read", "shell",
        "skill", "subagent", "webfetch", "websearch", "write", "patch",
      ]),
    );
    expect(names).not.toContain("pwsh");
  });

  test("429 is relayed without rotating the session", async () => {
    const response = await browser.post("/v1/chat/completions", chatBody("retry-once"));
    expect(response.status).toBe(429);
    expect(upstream.requests.length).toBe(1);
    expect((await response.json()).error.message).toBe("session quota");
  });

  test.each([true, false])("upstream errors keep the HTTP status (stream=%s)", async (stream) => {
    const limited = await browser.post(
      "/v1/chat/completions",
      chatBody("rate-limit", stream),
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("7");
    expect((await limited.json()).error.message).toBe("quota exceeded");

    const html = await browser.post(
      "/v1/chat/completions",
      chatBody("html-error", stream),
    );
    expect(html.status).toBe(502);
    expect((await html.json()).error.message).toBe("upstream unavailable");

    const unauthorized = await browser.post(
      "/v1/chat/completions",
      chatBody("unauthorized", stream),
    );
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("x-relay-auth-error")).toBeNull();
  });

  test("truncated non-stream responses do not claim success", async () => {
    const response = await browser.post(
      "/v1/chat/completions",
      chatBody("truncated"),
    );
    expect(response.status).toBe(502);
    expect((await response.json()).error.message).toContain("ended before completion");
  });

  test("invalid requests have the OpenAI error shape", async () => {
    for (const payload of [
      {},
      { model: "x", messages: [] },
      { ...chatBody(), max_tokens: 0 },
    ]) {
      const response = await browser.post("/v1/chat/completions", payload);
      expect(response.status).toBe(400);
      expect((await response.json()).error.type).toBe("invalid_request_error");
    }
  });

  test("optional relay auth is enforced", async () => {
    const authed = startApp({
      opencodeBaseUrl: upstream.url,
      relayApiKey: "relay-test",
      opencodeApiKey: "public",
    });
    try {
      const client = new Browser(authed);
      expect((await client.get("/api/health")).status).toBe(200);
      const missing = await client.get("/v1/models");
      expect(missing.status).toBe(401);
      expect(missing.headers.get("x-relay-auth-error")).toBe("1");
      expect(
        (await client.get("/v1/models", { headers: { authorization: "Bearer wrong" } }))
          .status,
      ).toBe(401);
      expect(
        (
          await client.get("/v1/models", {
            headers: { authorization: "Bearer relay-test" },
          })
        ).status,
      ).toBe(200);
    } finally {
      authed.stop();
    }
  });

  test("upstream key overrides are no longer accepted", async () => {
    const before = upstream.requests.length;
    const response = await browser.get("/v1/models", {
      headers: { "x-opencode-api-key": "bad key" },
    });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("bad key");
    expect(upstream.requests.length).toBe(before);
  });

  test("upstream timeout is 504", async () => {
    const slow = startApp({
      opencodeBaseUrl: upstream.url,
      opencodeApiKey: "test-key",
      timeoutSeconds: 0.15,
    });
    try {
      const client = new Browser(slow);
      expect((await client.post("/api/session", {})).status).toBe(200);
      const response = await client.post(
        "/v1/chat/completions",
        chatBody("slow-headers"),
      );
      expect(response.status).toBe(504);
      expect((await response.json()).error.code).toBe("upstream_timeout");
    } finally {
      slow.stop();
    }
  });

  test("disconnect before headers cancels the upstream request", async () => {
    const local = startApp({
      opencodeBaseUrl: upstream.url,
      opencodeApiKey: "test-key",
    });
    try {
      const client = new Browser(local);
      await client.post("/api/session", {});
      upstream.reset();
      const controller = new AbortController();
      const pending = client
        .post("/v1/chat/completions", chatBody("slow-headers"), {
          signal: controller.signal,
        })
        .catch(() => null);
      expect(await waitFor(() => upstream.requests.length === 1)).toBe(true);
      controller.abort();
      await pending;
      expect(
        await waitFor(() => upstream.requests[0]?.aborted === true),
      ).toBe(true);
    } finally {
      local.stop();
    }
  });

  test("disconnect after headers cancels the upstream stream", async () => {
    const local = startApp({
      opencodeBaseUrl: upstream.url,
      opencodeApiKey: "test-key",
    });
    try {
      const client = new Browser(local);
      await client.post("/api/session", {});
      upstream.reset();
      const controller = new AbortController();
      const response = await client.post(
        "/v1/chat/completions",
        chatBody("slow-stream", true),
        { signal: controller.signal },
      );
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      await reader.read();
      controller.abort();
      await reader.cancel().catch(() => undefined);
      expect(
        await waitFor(
          () =>
            upstream.requests[0]?.streamCancelled === true ||
            upstream.requests[0]?.aborted === true,
        ),
      ).toBe(true);
    } finally {
      local.stop();
    }
  });
});
