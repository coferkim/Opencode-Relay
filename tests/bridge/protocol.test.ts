import { describe, expect, test } from "bun:test";
import { aggregateChat } from "../../bridge/aggregate";
import { buildChatBody, buildRequestHeaders, createIdentity, createIdentityFromSeed } from "../../bridge/native/request";
import { parseSSE } from "../../bridge/native/sse";
import { readChatEvents } from "../../frontend/src/api";

function bytes(text: string, size = 1): ReadableStream<Uint8Array> {
  const encoded = new TextEncoder().encode(text);
  return new ReadableStream({ start(controller) {
    for (let index = 0; index < encoded.length; index += size) controller.enqueue(encoded.slice(index, index + size));
    controller.close();
  } });
}

describe("Bun native protocol", () => {
  test("preserves input and normalizes the required request body", () => {
    const input = { model: "test", messages: [{ role: "system" as const, content: "original" }],
      max_tokens: 12, stream: false, tool_choice: "none" };
    const body = buildChatBody(input);
    expect(input.messages[0]?.content).toBe("original");
    expect(body).toMatchObject({ stream: true, stream_options: { include_usage: true }, max_completion_tokens: 12 });
    expect(body.max_tokens).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    expect(JSON.stringify(body.messages)).toContain("Working directory:");
  });

  test("identity headers share the same session", () => {
    const identity = createIdentity();
    const headers = buildRequestHeaders({ identity, apiKey: "public", accept: "text/event-stream", json: true });
    expect(identity.sessionID).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(identity.projectID).toMatch(/^[0-9a-f]{40}$/);
    expect(headers["x-opencode-session"]).toBe(headers["x-session-id"]);
    expect(headers.authorization).toBe("Bearer public");
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
    const text = ': comment\r\nid: 1\r\ndata: 你好\r\ndata: 世界\r\n\r\ndata: [DONE]\n\n';
    const events = [];
    for await (const event of parseSSE(bytes(text))) events.push(event);
    expect(events[0]).toMatchObject({ data: "你好\n世界", id: "1" });
    expect(events[1]?.data).toBe("[DONE]");
  });

  test("aggregates multiple choice indices and real finish reasons", async () => {
    const text = [
      { id: "id", model: "test", created: 2, choices: [{ index: 1, delta: { content: "B" } }, { index: 0, delta: { content: "A" } }] },
      { choices: [{ index: 0, delta: { content: "1" }, finish_reason: "length" }, { index: 1, delta: { content: "2" }, finish_reason: "stop" }] },
      { choices: [], usage: { total_tokens: 10 } },
    ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
    const result = await aggregateChat(bytes(text));
    expect(result.choices[0].message.content).toBe("A1");
    expect(result.choices[0].finish_reason).toBe("length");
    expect(result.choices[1].message.content).toBe("B2");
    expect(result.usage.total_tokens).toBe(10);
  });

  test("frontend reads split utf8 and does not lose a final event", async () => {
    const chunks = [];
    for await (const chunk of readChatEvents(bytes('data: {"choices":[{"delta":{"content":"中文"}}]}\r\n\r\ndata: [DONE]'))) chunks.push(chunk);
    expect(chunks[0]?.choices?.[0]?.delta?.content).toBe("中文");
  });

  test("frontend surfaces SSE error envelopes and truncated streams", async () => {
    const consume = async (text: string) => {
      for await (const _chunk of readChatEvents(bytes(text))) { /* consume */ }
    };
    expect(consume('data: {"error":{"message":"quota"}}\n\n')).rejects.toThrow("quota");
    expect(consume('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')).rejects.toThrow("中断");
  });
});
