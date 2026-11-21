/**
 * Streaming bridge: consume the upstream Chat Completions SSE and emit the
 * client protocol's own event stream.
 *
 * Anthropic Messages SSE:  message_start → content_block_start/delta/stop …
 *                          → message_delta (stop_reason, usage) → message_stop
 * OpenAI Responses SSE:    response.created → response.output_item.added /
 *                          response.output_text.delta / … → response.completed
 *
 * Chat clients keep the raw upstream stream (only tool names are restored).
 *
 * Both translators are written as `start`-driven producers: one async loop
 * reads upstream events and enqueues translated frames. A `pull`-driven
 * design stalls under Bun whenever an upstream event produces no frame
 * (role-only deltas, finish chunks, usage-only chunks), because a pull that
 * enqueues nothing is never called again.
 */
import { parseSSE } from "./sse";
import {
  randomId,
  type AnthropicContext,
  type BridgeResponse,
  type BridgeUsage,
  type ResponsesContext,
} from "./bridge";
import type { ToolRenames } from "./request";

interface StreamAccumulator {
  id: string;
  model: string;
  created: number;
  text: string;
  reasoning: string;
  toolCalls: { index: number; id: string; name: string; arguments: string }[];
  finishReason: string | null;
  usage: BridgeUsage;
}

function emptyUsage(): BridgeUsage {
  return { input: 0, output: 0, total: 0, cached: 0, reasoning: 0 };
}

function newAccumulator(): StreamAccumulator {
  return {
    id: "",
    model: "",
    created: 0,
    text: "",
    reasoning: "",
    toolCalls: [],
    finishReason: null,
    usage: emptyUsage(),
  };
}

function resolveName(name: string, toolNames?: ToolRenames): string {
  return toolNames ? toolNames.resolve(name) : name;
}

function absorbChunk(state: StreamAccumulator, chunk: Record<string, any>): void {
  if (chunk.id) state.id = String(chunk.id);
  if (chunk.model) state.model = String(chunk.model);
  if (chunk.created) state.created = Number(chunk.created);
  if (chunk.usage) {
    const usage = chunk.usage;
    state.usage.input = Number(usage.prompt_tokens ?? state.usage.input);
    state.usage.output = Number(usage.completion_tokens ?? state.usage.output);
    state.usage.total = Number(usage.total_tokens ?? state.usage.total);
    state.usage.cached = Number(usage.prompt_tokens_details?.cached_tokens ?? state.usage.cached);
    state.usage.reasoning = Number(usage.completion_tokens_details?.reasoning_tokens ?? state.usage.reasoning);
  }
  for (const choice of chunk.choices ?? []) {
    const delta = choice.delta ?? {};
    if (typeof delta.content === "string") state.text += delta.content;
    if (typeof delta.reasoning_content === "string") state.reasoning += delta.reasoning_content;
    for (const call of delta.tool_calls ?? []) {
      const index = Number(call.index ?? 0);
      let target = state.toolCalls.find((entry) => entry.index === index);
      if (!target) {
        target = { index, id: "", name: "", arguments: "" };
        state.toolCalls.push(target);
      }
      if (call.id) target.id = String(call.id);
      if (call.function?.name) target.name += String(call.function.name);
      if (call.function?.arguments) target.arguments += String(call.function.arguments);
    }
    if (choice.finish_reason != null) state.finishReason = String(choice.finish_reason);
  }
}

function finalize(state: StreamAccumulator, toolNames?: ToolRenames): BridgeResponse {
  return {
    id: state.id || randomId("chatcmpl", 12),
    model: state.model,
    created: state.created || Math.floor(Date.now() / 1000),
    text: state.text,
    reasoning: state.reasoning,
    toolCalls: state.toolCalls
      .sort((a, b) => a.index - b.index)
      .map((call) => ({
        id: call.id || randomId("call", 8),
        name: resolveName(call.name, toolNames),
        arguments: call.arguments || "{}",
      })),
    finishReason: state.finishReason,
    usage: state.usage,
  };
}

/** Fold one upstream Chat SSE stream into a complete BridgeResponse. */
export async function collapseChatStream(
  stream: ReadableStream<Uint8Array>,
  toolNames?: ToolRenames,
): Promise<BridgeResponse> {
  const state = newAccumulator();
  for await (const event of parseSSE(stream)) {
    if (event.data === "[DONE]") break;
    let chunk: Record<string, any>;
    try {
      chunk = JSON.parse(event.data);
    } catch {
      continue;
    }
    if (chunk.error) throw new Error(chunk.error.message ?? "Upstream stream error");
    absorbChunk(state, chunk);
  }
  return finalize(state, toolNames);
}

function sseFrame(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function anthropicStopReason(finishReason: string | null): string {
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

/* ------------------------------------------------------------------ */
/* Anthropic Messages stream                                           */
/* ------------------------------------------------------------------ */

export function anthropicSseStream(
  source: ReadableStream<Uint8Array>,
  toolNames: ToolRenames | undefined,
  context: AnthropicContext,
): ReadableStream<Uint8Array> {
  const state = newAccumulator();
  let textBlock = -1;
  let thinkingBlock = -1;
  let blockIndex = 0;
  const toolBlocks = new Map<number, { index: number; id: string }>();
  let cancelled = false;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (!cancelled) controller.enqueue(sseFrame(event, data));
      };
      const closeBlock = (which: "text" | "thinking") => {
        if (which === "text" && textBlock >= 0) {
          send("content_block_stop", { type: "content_block_stop", index: textBlock });
          textBlock = -1;
        }
        if (which === "thinking" && thinkingBlock >= 0) {
          send("content_block_stop", { type: "content_block_stop", index: thinkingBlock });
          thinkingBlock = -1;
        }
      };

      let started = false;
      const startMessage = () => {
        if (started) return;
        started = true;
        send("message_start", {
          type: "message_start",
          message: {
            id: randomId("msg", 12),
            type: "message",
            role: "assistant",
            model: state.model || "unknown",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: state.usage.input, output_tokens: 0 },
          },
        });
      };

      try {
        for await (const event of parseSSE(source)) {
          if (cancelled) return;
          if (event.data === "[DONE]") break;
          let chunk: Record<string, any>;
          try {
            chunk = JSON.parse(event.data);
          } catch {
            continue;
          }
          if (chunk.error) throw new Error(chunk.error.message ?? "Upstream stream error");
          absorbChunk(state, chunk);
          startMessage();

          const delta = chunk.choices?.[0]?.delta ?? {};

          if (context.thinkingRequested && typeof delta.reasoning_content === "string" && delta.reasoning_content) {
            if (thinkingBlock < 0 && textBlock < 0) {
              thinkingBlock = blockIndex++;
              send("content_block_start", {
                type: "content_block_start",
                index: thinkingBlock,
                content_block: { type: "thinking", thinking: "", signature: "" },
              });
            }
            if (thinkingBlock >= 0) {
              send("content_block_delta", {
                type: "content_block_delta",
                index: thinkingBlock,
                delta: { type: "thinking_delta", thinking: String(delta.reasoning_content) },
              });
            }
          }

          if (typeof delta.content === "string" && delta.content) {
            if (textBlock < 0) {
              closeBlock("thinking");
              textBlock = blockIndex++;
              send("content_block_start", {
                type: "content_block_start",
                index: textBlock,
                content_block: { type: "text", text: "" },
              });
            }
            send("content_block_delta", {
              type: "content_block_delta",
              index: textBlock,
              delta: { type: "text_delta", text: String(delta.content) },
            });
          }

          for (const call of delta.tool_calls ?? []) {
            const wireIndex = Number(call.index ?? 0);
            let block = toolBlocks.get(wireIndex);
            if (!block) {
              closeBlock("thinking");
              closeBlock("text");
              block = { index: blockIndex++, id: String(call.id ?? randomId("toolu", 12)) };
              toolBlocks.set(wireIndex, block);
              send("content_block_start", {
                type: "content_block_start",
                index: block.index,
                content_block: {
                  type: "tool_use",
                  id: block.id,
                  name: resolveName(String(call.function?.name ?? ""), toolNames),
                  input: {},
                },
              });
            }
            if (typeof call.function?.arguments === "string" && call.function.arguments) {
              send("content_block_delta", {
                type: "content_block_delta",
                index: block.index,
                delta: { type: "input_json_delta", partial_json: call.function.arguments },
              });
            }
          }
        }

        if (cancelled) return;
        startMessage();
        closeBlock("thinking");
        closeBlock("text");
        for (const block of toolBlocks.values()) {
          send("content_block_stop", { type: "content_block_stop", index: block.index });
        }
        send("message_delta", {
          type: "message_delta",
          delta: {
            stop_reason: anthropicStopReason(state.finishReason),
            stop_sequence: null,
          },
          usage: { output_tokens: state.usage.output },
        });
        send("message_stop", { type: "message_stop" });
        controller.close();
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : "Upstream stream error";
        try {
          controller.enqueue(
            sseFrame("error", { type: "error", error: { type: "api_error", message } }),
          );
        } catch {
          /* Already closed. */
        }
        try {
          controller.close();
        } catch {
          /* Already closed. */
        }
      }
    },
    cancel() {
      cancelled = true;
    },
  });
}

/* ------------------------------------------------------------------ */
/* OpenAI Responses stream                                             */
/* ------------------------------------------------------------------ */

export function responsesSseStream(
  source: ReadableStream<Uint8Array>,
  toolNames: ToolRenames | undefined,
  context: ResponsesContext,
): ReadableStream<Uint8Array> {
  const state = newAccumulator();
  let sequence = 0;
  const createdAt = context.createdAt;
  const messageItemId = randomId("msg", 12);
  let textOpen = false;
  const toolItems = new Map<number, { id: string; outputIndex: number; wireIndex: number }>();
  let nextOutputIndex = 0;
  let cancelled = false;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (type: string, payload: Record<string, unknown>) => {
        if (cancelled) return;
        controller.enqueue(sseFrame(type, { type, sequence_number: sequence++, ...payload }));
      };

      const responseStub = (status: string) => ({
        id: context.id,
        object: "response",
        created_at: createdAt,
        status,
        error: null,
        incomplete_details: null,
        instructions: context.instructions ?? null,
        max_output_tokens: context.maxOutputTokens ?? null,
        model: state.model || "unknown",
        output: [],
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
        usage: null,
        user: null,
        metadata: context.metadata ?? {},
      });

      const buildOutput = (): Record<string, unknown>[] => {
        const output: Record<string, unknown>[] = [];
        if (textOpen) {
          output.push({
            type: "message",
            id: messageItemId,
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: state.text, annotations: [] }],
          });
        }
        for (const call of [...toolItems.values()].sort((a, b) => a.outputIndex - b.outputIndex)) {
          const accumulated = state.toolCalls.find((entry) => entry.index === call.wireIndex);
          output.push({
            type: "function_call",
            id: call.id,
            call_id: accumulated?.id || call.id,
            name: resolveName(accumulated?.name ?? "", toolNames),
            arguments: accumulated?.arguments || "{}",
            status: "completed",
          });
        }
        return output;
      };

      try {
        emit("response.created", { response: responseStub("in_progress") });
        emit("response.in_progress", { response: responseStub("in_progress") });

        for await (const event of parseSSE(source)) {
          if (cancelled) return;
          if (event.data === "[DONE]") break;
          let chunk: Record<string, any>;
          try {
            chunk = JSON.parse(event.data);
          } catch {
            continue;
          }
          if (chunk.error) throw new Error(chunk.error.message ?? "Upstream stream error");
          absorbChunk(state, chunk);

          const delta = chunk.choices?.[0]?.delta ?? {};
          if (typeof delta.content === "string" && delta.content) {
            if (!textOpen) {
              textOpen = true;
              emit("response.output_item.added", {
                output_index: 0,
                item: { type: "message", id: messageItemId, status: "in_progress", role: "assistant", content: [] },
              });
              emit("response.content_part.added", {
                item_id: messageItemId,
                output_index: 0,
                content_index: 0,
                part: { type: "output_text", text: "", annotations: [] },
              });
            }
            emit("response.output_text.delta", {
              item_id: messageItemId,
              output_index: 0,
              content_index: 0,
              delta: String(delta.content),
            });
          }

          for (const call of delta.tool_calls ?? []) {
            const wireIndex = Number(call.index ?? 0);
            let item = toolItems.get(wireIndex);
            if (!item) {
              item = { id: randomId("fc", 12), outputIndex: nextOutputIndex++, wireIndex };
              toolItems.set(wireIndex, item);
              emit("response.output_item.added", {
                output_index: item.outputIndex,
                item: {
                  type: "function_call",
                  id: item.id,
                  call_id: call.id ?? randomId("call", 12),
                  name: resolveName(String(call.function?.name ?? ""), toolNames),
                  arguments: "",
                  status: "in_progress",
                },
              });
            }
            if (typeof call.function?.arguments === "string" && call.function.arguments) {
              emit("response.function_call_arguments.delta", {
                item_id: item.id,
                output_index: item.outputIndex,
                delta: String(call.function.arguments),
              });
            }
          }
        }

        if (cancelled) return;
        if (textOpen) {
          emit("response.output_text.done", {
            item_id: messageItemId,
            output_index: 0,
            content_index: 0,
            text: state.text,
          });
          emit("response.content_part.done", {
            item_id: messageItemId,
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: state.text, annotations: [] },
          });
          emit("response.output_item.done", {
            output_index: 0,
            item: {
              type: "message",
              id: messageItemId,
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text: state.text, annotations: [] }],
            },
          });
        }
        for (const call of [...toolItems.values()].sort((a, b) => a.outputIndex - b.outputIndex)) {
          const accumulated = state.toolCalls.find((entry) => entry.index === call.wireIndex);
          emit("response.output_item.done", {
            output_index: call.outputIndex,
            item: {
              type: "function_call",
              id: call.id,
              call_id: accumulated?.id || call.id,
              name: resolveName(accumulated?.name ?? "", toolNames),
              arguments: accumulated?.arguments || "{}",
              status: "completed",
            },
          });
        }
        const incomplete = state.finishReason === "length";
        emit("response.completed", {
          response: {
            ...responseStub(incomplete ? "incomplete" : "completed"),
            incomplete_details: incomplete ? { reason: "max_output_tokens" } : null,
            output_text: state.text,
            output: buildOutput(),
            usage: {
              input_tokens: state.usage.input,
              input_tokens_details: { cached_tokens: state.usage.cached },
              output_tokens: state.usage.output,
              output_tokens_details: { reasoning_tokens: state.usage.reasoning },
              total_tokens: state.usage.total,
            },
          },
        });
        controller.close();
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : "Upstream stream error";
        try {
          emit("response.failed", {
            response: { ...responseStub("failed"), error: { code: "api_error", message } },
          });
        } catch {
          /* Already closed. */
        }
        try {
          controller.close();
        } catch {
          /* Already closed. */
        }
      }
    },
    cancel() {
      cancelled = true;
    },
  });
}
