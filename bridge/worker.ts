import { aggregateChat } from "./aggregate";
import {
  buildChatBody,
  buildRequestHeaders,
  createIdentity,
  createIdentityFromSeed,
  restoreToolNamesInResponse,
} from "./native/request";
import { parseSSE } from "./native/sse";
import type { ChatCompletionRequest } from "./native/types";

// stdout: one JSON metadata line followed by the unmodified HTTP body.
// No credentials or prompts are written to stderr.
let headersSent = false;
async function head(status: number, headers: Headers | Record<string, string> = {}) {
  const normalized = headers instanceof Headers ? Object.fromEntries(headers.entries()) : headers;
  await Bun.write(Bun.stdout, `${JSON.stringify({ status, headers: normalized })}\n`);
  headersSent = true;
}

try {
  const input = await Bun.stdin.json() as {
    action: "models" | "chat";
    request?: ChatCompletionRequest;
    identitySeed?: string;
  };
  const baseURL = (process.env.OPENCODE_BASE_URL ?? "https://opencode.ai/inference/openai/v1").replace(/\/+$/, "");
  const modelsURL = process.env.OPENCODE_MODELS_URL?.trim() || (
    baseURL.endsWith("/openai/v1")
      ? `${baseURL.slice(0, -"/openai/v1".length)}/v1/models`
      : `${baseURL}/models`
  );
  const identity = input.identitySeed
    ? createIdentityFromSeed(input.identitySeed, {
        client: process.env.OPENCODE_CLIENT ?? "desktop",
        version: process.env.OPENCODE_VERSION ?? "2.2.5",
      })
    : createIdentity({
        client: process.env.OPENCODE_CLIENT ?? "desktop",
        version: process.env.OPENCODE_VERSION ?? "2.2.5",
      });
  const isChat = input.action === "chat";
  if (input.action !== "models" && !isChat) throw new Error("Unknown worker action");
  if (isChat && !input.request) throw new Error("Missing Chat request");
  const built = isChat ? buildChatBody(input.request!) : undefined;
  const toolNames = built?.toolNames ?? new Map<string, string>();
  const response = await fetch(isChat ? `${baseURL}/chat/completions` : modelsURL, {
    method: isChat ? "POST" : "GET",
    headers: buildRequestHeaders({
      apiKey: process.env.OPENCODE_API_KEY ?? "public",
      identity,
      accept: isChat ? "text/event-stream" : "application/json",
      json: isChat,
    }),
    ...(built ? { body: JSON.stringify(built.body) } : {}),
    signal: AbortSignal.timeout(Number(process.env.OPENCODE_TIMEOUT_MS ?? 120000)),
  });

  if (response.ok && isChat && input.request?.stream !== true) {
    if (!response.body) throw new Error("Upstream response has no body");
    const result = await aggregateChat(response.body);
    restoreToolNamesInResponse(result, toolNames);
    await head(response.status, response.headers);
    await Bun.write(Bun.stdout, JSON.stringify(result));
  } else {
    await head(response.status, response.headers);
    if (response.body) {
      if (isChat && input.request?.stream === true && toolNames.size > 0) {
        for await (const event of parseSSE(response.body)) {
          let data = event.data;
          if (data !== "[DONE]") {
            try {
              const payload = JSON.parse(data);
              restoreToolNamesInResponse(payload, toolNames);
              data = JSON.stringify(payload);
            } catch {
              // Preserve non-JSON events verbatim.
            }
          }
          const fields = [
            event.event !== "message" ? `event: ${event.event}` : "",
            event.id !== undefined ? `id: ${event.id}` : "",
            event.retry !== undefined ? `retry: ${event.retry}` : "",
            `data: ${data}`,
          ].filter(Boolean);
          await Bun.write(Bun.stdout, `${fields.join("\n")}\n\n`);
        }
      } else {
        for await (const chunk of response.body) await Bun.write(Bun.stdout, chunk);
      }
    }
  }
} catch (error) {
  const timeout = error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name);
  const body = { error: {
    message: error instanceof Error ? error.message : "Bun upstream request failed",
    type: "api_error", param: null, code: timeout ? "upstream_timeout" : "upstream_error",
  } };
  if (!headersSent) {
    await head(timeout ? 504 : 502);
    await Bun.write(Bun.stdout, JSON.stringify(body));
  } else {
    // A nonzero exit lets FastAPI report a truncated stream without corrupting the body.
    process.exitCode = 1;
  }
}
