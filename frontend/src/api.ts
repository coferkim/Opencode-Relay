export interface Model {
  id: string;
  name?: string;
  owned_by?: string;
  is_free: boolean;
  context_length?: number;
  limit?: { context?: number; output?: number };
  cost?: { text?: { input?: { price?: number }; output?: { price?: number } } };
  [key: string]: unknown;
}

export interface ChatRequest {
  model: string;
  messages: { role: "system" | "user"; content: string }[];
  stream: boolean;
  max_completion_tokens: number;
}

export interface ChatChunk {
  id?: string;
  model?: string;
  choices?: {
    index?: number;
    delta?: { content?: string; reasoning_content?: string; tool_calls?: unknown[] };
    message?: { content?: string; reasoning_content?: string; tool_calls?: unknown[] };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: { message?: string };
  [key: string]: unknown;
}

export interface RelaySettings {
  api_key: { exists: boolean; prefix: string | null; created_at: number | null; updated_at: number | null };
  upstream: { configured: boolean };
}

export class ApiError extends Error {
  constructor(message: string, public status: number, public authRequired = false) { super(message); }
}

async function checkResponse(response: Response): Promise<void> {
  if (response.ok) return;
  let message = `HTTP ${response.status}`;
  try {
    const body = await response.json();
    message = body.error?.message ?? body.detail ?? message;
  } catch { /* Keep HTTP status if upstream error is not JSON. */ }
  const retry = response.headers.get("retry-after");
  const authRequired = response.headers.get("x-relay-auth-error") === "1";
  throw new ApiError(`${message}${retry ? `（请在 ${retry} 秒后重试）` : ""}`, response.status, authRequired);
}

export async function apiJSON<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method, credentials: "same-origin", cache: "no-store",
    ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  await checkResponse(response);
  return await response.json() as T;
}

export async function listModels(signal?: AbortSignal): Promise<Model[]> {
  const response = await fetch("/v1/models", { credentials: "same-origin", cache: "no-store", signal });
  await checkResponse(response);
  const result = await response.json();
  if (!Array.isArray(result.data)) throw new Error("模型列表格式不正确。");
  return result.data;
}

/** Incremental SSE decoding, including CRLF split across reads and UTF-8 code points. */
export async function* readChatEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<ChatChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  let completed = false;
  let terminalChoice = false;

  function parse(line: string): string | undefined {
    if (!line) {
      if (data.length === 0) return;
      const event = data.join("\n");
      data = [];
      return event;
    }
    if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }

  try {
    while (!completed) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      while (buffer.length > 0) {
        const position = buffer.search(/[\r\n]/);
        if (position < 0) break;
        if (!done && buffer[position] === "\r" && position === buffer.length - 1) break;
        const line = buffer.slice(0, position);
        const width = buffer[position] === "\r" && buffer[position + 1] === "\n" ? 2 : 1;
        buffer = buffer.slice(position + width);
        const event = parse(line);
        if (event === undefined) continue;
        if (event === "[DONE]") { completed = true; break; }
        const chunk = JSON.parse(event) as ChatChunk;
        if (chunk.error) throw new Error(chunk.error.message ?? "上游流式请求失败。");
        terminalChoice ||= Boolean(chunk.choices?.some((choice) => choice.finish_reason != null));
        yield chunk;
      }
      if (done) {
        if (buffer) parse(buffer);
        const tail = parse("");
        if (tail === "[DONE]") completed = true;
        else if (tail) {
          const chunk = JSON.parse(tail) as ChatChunk;
          if (chunk.error) throw new Error(chunk.error.message ?? "上游流式请求失败。");
          terminalChoice ||= Boolean(chunk.choices?.some((choice) => choice.finish_reason != null));
          yield chunk;
        }
        if (!completed && !terminalChoice) throw new Error("响应意外中断，尚未收到完成标记。");
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function sendChat(
  request: ChatRequest,
  signal: AbortSignal,
  onChunk: (chunk: ChatChunk) => void,
  onResponse: (response: Response) => void,
): Promise<void> {
  const response = await fetch("/v1/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin",
    body: JSON.stringify(request), signal,
  });
  onResponse(response);
  await checkResponse(response);
  if (request.stream) {
    if (!response.body) throw new Error("响应流为空。");
    for await (const chunk of readChatEvents(response.body)) onChunk(chunk);
  } else {
    onChunk(await response.json());
  }
}
