import { parseSSE } from "./native/sse";

type AnyRecord = Record<string, any>;

/** Preserve every choice, tool-call fragment, finish reason, and usage from Chat SSE. */
export async function aggregateChat(stream: ReadableStream<Uint8Array>): Promise<AnyRecord> {
  const choices = new Map<number, AnyRecord>();
  const response: AnyRecord = { object: "chat.completion" };
  let completed = false;
  for await (const event of parseSSE(stream)) {
    if (event.data === "[DONE]") { completed = true; break; }
    const chunk = JSON.parse(event.data) as AnyRecord;
    if (chunk.error) throw new Error(chunk.error.message ?? "Upstream stream error");
    for (const key of ["id", "created", "model", "system_fingerprint", "service_tier"]) {
      if (chunk[key] !== undefined) response[key] = chunk[key];
    }
    if (chunk.usage) response.usage = chunk.usage;
    for (const item of chunk.choices ?? []) {
      const index = item.index ?? 0;
      const choice = choices.get(index) ?? {
        index, message: { role: "assistant", content: null }, finish_reason: null,
      };
      const delta = item.delta ?? {};
      if (delta.role) choice.message.role = delta.role;
      for (const field of ["content", "reasoning_content", "refusal"]) {
        if (typeof delta[field] === "string") {
          choice.message[field] = (choice.message[field] ?? "") + delta[field];
        }
      }
      for (const call of delta.tool_calls ?? []) {
        const calls: AnyRecord[] = choice.message.tool_calls ??= [];
        const position = call.index ?? 0;
        const target = calls[position] ??= { type: "function", function: { name: "", arguments: "" } };
        if (call.id) target.id = call.id;
        if (call.type) target.type = call.type;
        if (call.function?.name) target.function.name += call.function.name;
        if (call.function?.arguments) target.function.arguments += call.function.arguments;
      }
      if (delta.function_call) {
        const fn = choice.message.function_call ??= { name: "", arguments: "" };
        fn.name += delta.function_call.name ?? "";
        fn.arguments += delta.function_call.arguments ?? "";
      }
      if (item.finish_reason != null) choice.finish_reason = item.finish_reason;
      if (item.logprobs != null) choice.logprobs = item.logprobs;
      choices.set(index, choice);
    }
  }
  if (!completed && ![...choices.values()].every((choice) => choice.finish_reason !== null)) {
    throw new Error("Upstream stream ended before completion");
  }
  if (choices.size === 0) throw new Error("Upstream returned no completion choices");
  response.choices = [...choices.values()].sort((a, b) => a.index - b.index);
  return response;
}
