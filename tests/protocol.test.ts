import { describe, expect, test } from "bun:test";

import { readChatEvents } from "../server/frontend/src/api";
import { aggregateChat } from "../server/protocol/aggregate";
import {
  isOfficialSessionID,
  phaseAgeMs,
  sessionPhaseMs,
} from "../server/protocol/identity";
import {
  buildChatBody,
  buildRequestHeaders,
  createIdentity,
  createIdentityFromSeed,
  restoreToolNamesInResponse,
} from "../server/protocol/request";
import { parseSSE } from "../server/protocol/sse";

function bytes(text: string, size = 1): ReadableStream<Uint8Array> {
  const encoded = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      for (let index = 0; index < encoded.length; index += size) {
        controller.enqueue(encoded.slice(index, index + size));
      }
      controller.close();
    },
  });
}

describe("Bun native protocol", () => {
  test("preserves input and normalizes the required request body", () => {
    const input = {
      model: "test",
      messages: [{ role: "system" as const, content: "original" }],
      max_tokens: 12,
      stream: false,
      tool_choice: "none",
    };
    const { body } = buildChatBody(input);
    expect(input.messages[0]?.content).toBe("original");
    expect(body).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
      max_completion_tokens: 12,
    });
    expect(body.max_tokens).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    expect(JSON.stringify(body.messages)).toContain("Working directory:");
  });

  test("renames caller tools and appends the official 13-tool set", () => {
    const { body, toolNames } = buildChatBody({
      model: "test",
      messages: [{ role: "user", content: "hello" }],
      tools: [
        {
          type: "function",
          function: { name: "pwsh", description: "Run shell", parameters: {} },
        },
      ],
    });
    const tools = body.tools as Array<{
      function?: { name?: string; description?: string; strict?: boolean };
      name?: string;
    }>;
    const names = tools.map((tool) => tool.function?.name ?? tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "edit", "execute", "glob", "grep", "question", "read", "shell",
        "skill", "subagent", "webfetch", "websearch", "write", "patch",
      ]),
    );
    expect(names).not.toContain("pwsh");
    const wire = names.find((name) => name?.startsWith("mcp_"));
    expect(wire).toBeDefined();
    expect(toolNames.get(wire!)).toBe("pwsh");
    // The caller's description travels NBSP-encoded so foreign wording never
    // matches the gate's literal checks.
    const caller = tools.find((tool) => tool.function?.name === wire)!;
    expect(caller.function?.description).toBe("Run shell");
    // The appended officials carry the client's `strict: false`.
    const shell = tools.find((tool) => tool.function?.name === "shell")!;
    expect(shell.function?.strict).toBe(false);
    expect(new Set(names).size).toBe(names.length);
  });

  test("injects the environment context (no persona) and is idempotent", () => {
    const request = {
      model: "test",
      messages: [{ role: "system" as const, content: "caller instructions" }],
    };
    const first = buildChatBody(request).body;
    const system = (first.messages as Array<{ role: string; content: string }>)[0]!;
    expect(system.role).toBe("system");
    // The gate reads the env block; a persona prompt is not injected.
    expect(system.content).toContain("<env>");
    expect(system.content).toContain("Working directory:");
    expect(system.content).toContain("Today's date:");
    expect(system.content).not.toContain("You are opencode");
    expect(system.content).toContain("caller instructions");

    const again = buildChatBody({
      ...request,
      messages: first.messages as never,
    }).body;
    const second = (again.messages as Array<{ content: string }>)[0]!.content;
    expect(second.match(/<env>/g)).toHaveLength(1);
  });

  test("title requests pass through unshaped", () => {
    const { body } = buildChatBody({
      model: "test",
      messages: [
        { role: "user", content: "Generate a title for this conversation: 你好" },
      ],
    });
    expect(body.tools).toBeUndefined();
    expect(JSON.stringify(body.messages)).not.toContain("<env>");
    expect(body.max_completion_tokens).toBe(32000);
  });

  test("never ships tool_choice none", () => {
    const { body } = buildChatBody({
      model: "test",
      messages: [{ role: "user", content: "hi" }],
      tool_choice: "none",
    });
    expect(body.tool_choice).toBeUndefined();
  });

  test("chat bodies keep the client key order", () => {
    const { body } = buildChatBody({
      model: "test",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(Object.keys(body).slice(0, 6)).toEqual([
      "model",
      "messages",
      "tools",
      "stream",
      "stream_options",
      "max_completion_tokens",
    ]);
  });

  test("restores opaque tool names in responses", () => {
    const chunk = {
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, function: { name: "tool_0", arguments: "{}" } }],
          },
        },
      ],
    };
    restoreToolNamesInResponse(chunk, new Map([["tool_0", "pwsh"]]));
    expect(chunk.choices[0]?.delta.tool_calls[0]?.function.name).toBe("pwsh");
  });

  test("official-spelled client tools bind their names for restoration", () => {
    const { body, toolNames } = buildChatBody({
      model: "test",
      messages: [{ role: "user", content: "read a file" }],
      tools: [
        {
          type: "function",
          function: {
            name: "Read",
            description: "Reads a file.",
            parameters: { type: "object", properties: { file_path: { type: "string" } } },
          },
        },
      ],
    });
    const names = (body.tools as Array<{ function?: { name?: string } }>).map(
      (tool) => tool.function?.name,
    );
    // The client tool is opaque on the wire; the official set is appended once.
    expect(names.filter((name) => name?.startsWith("mcp_"))).toHaveLength(1);
    expect(names.filter((name) => name === "read")).toHaveLength(1);
    expect(toolNames.resolve("read")).toBe("Read");
    expect(toolNames.resolve("shell")).toBe("shell");
  });

  test("session ids carry a plausible recent timestamp", () => {
    const identity = createIdentityFromSeed("conversation-42");
    expect(identity.sessionID).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(isOfficialSessionID(identity.sessionID)).toBe(true);
    // The encoded date is within the accepted window, never 1970.
    const phase = sessionPhaseMs(identity.sessionID)!;
    expect(phaseAgeMs(phase)).toBeLessThan(31 * 24 * 60 * 60 * 1000);
  });

  test("identity headers carry the v2 client set", () => {
    const identity = createIdentity();
    const headers = buildRequestHeaders({
      identity,
      apiKey: "public",
      json: true,
    });
    expect(headers["user-agent"]).toBe("opencode/latest/2.1.1/cli");
    expect(headers["x-opencode-client"]).toBe("cli");
    expect(headers["x-opencode-session-id"]).toBe(identity.sessionID);
    expect(headers["x-opencode-request"]).toBeUndefined();
    expect(headers.accept).toBeUndefined();
    expect(headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(headers.b3).toMatch(/^[0-9a-f]{32}-[0-9a-f]{16}-1-[0-9a-f]{16}$/);
    expect(headers["x-opencode-project"]).toMatch(/^[0-9a-f]{40}$/);
  });

  test("derives one stable upstream identity from a conversation seed", () => {
    const first = createIdentityFromSeed("conversation-42");
    const second = createIdentityFromSeed("conversation-42");
    const other = createIdentityFromSeed("conversation-43");
    expect(first).toEqual(second);
    expect(first.sessionID).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(first.projectID).toMatch(/^[0-9a-f]{40}$/);
    expect(other.sessionID).not.toBe(first.sessionID);
    expect(other.projectID).not.toBe(first.projectID);
  });

  test("SSE handles split CRLF, unicode, comments, and multiline data", async () => {
    const text =
      ": comment\r\nid: 1\r\ndata: 你好\r\ndata: 世界\r\n\r\ndata: [DONE]\n\n";
    const events = [];
    for await (const event of parseSSE(bytes(text))) events.push(event);
    expect(events[0]).toMatchObject({ data: "你好\n世界", id: "1" });
    expect(events[1]?.data).toBe("[DONE]");
  });

  test("aggregates multiple choice indices and real finish reasons", async () => {
    const text =
      [
        {
          id: "id",
          model: "test",
          created: 2,
          choices: [
            { index: 1, delta: { content: "B" } },
            { index: 0, delta: { content: "A" } },
          ],
        },
        {
          choices: [
            { index: 0, delta: { content: "1" }, finish_reason: "length" },
            { index: 1, delta: { content: "2" }, finish_reason: "stop" },
          ],
        },
        { choices: [], usage: { total_tokens: 10 } },
      ]
        .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
        .join("") + "data: [DONE]\n\n";
    const result = await aggregateChat(bytes(text));
    expect(result.choices[0].message.content).toBe("A1");
    expect(result.choices[0].finish_reason).toBe("length");
    expect(result.choices[1].message.content).toBe("B2");
    expect(result.usage.total_tokens).toBe(10);
  });

  test("frontend reads split utf8 and does not lose a final event", async () => {
    const chunks = [];
    for await (const chunk of readChatEvents(
      bytes('data: {"choices":[{"delta":{"content":"中文"}}]}\r\n\r\ndata: [DONE]'),
    )) {
      chunks.push(chunk);
    }
    expect(chunks[0]?.choices?.[0]?.delta?.content).toBe("中文");
  });

  test("frontend surfaces SSE error envelopes and truncated streams", async () => {
    const consume = async (text: string) => {
      for await (const _chunk of readChatEvents(bytes(text))) {
        /* consume */
      }
    };
    expect(consume('data: {"error":{"message":"quota"}}\n\n')).rejects.toThrow("quota");
    expect(
      consume('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'),
    ).rejects.toThrow("中断");
  });
});
