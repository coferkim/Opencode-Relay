import { RelayError } from "./errors";
import type { ChatCompletionRequest } from "./protocol/types";

const ROLES = new Set(["system", "developer", "user", "assistant", "tool", "function"]);
const CREDENTIAL_FIELDS = new Set(["api_key", "apikey", "opencode_api_key", "authorization"]);

function invalid(problems: string[]): never {
  throw new RelayError(
    problems.join("; "),
    400,
    "invalid_request",
    "invalid_request_error",
  );
}

export function parseJsonObject(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    invalid(["body: 必须是合法 JSON。"]);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid(["body: 必须是 JSON 对象。"]);
  }
  return value as Record<string, unknown>;
}

/** Visible ASCII only, matching the original pydantic validator. */
export function parseKeyInput(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") invalid(["api_key: 必须是字符串。"]);
  const key = value.trim();
  if (key.length > 4096 || /[^\x21-\x7E]/.test(key)) {
    invalid(["API Key 必须为可见 ASCII 字符，最多 4096 字符"]);
  }
  return key;
}

export function validateChatRequest(value: Record<string, unknown>): ChatCompletionRequest {
  const problems: string[] = [];
  const model = value.model;
  if (
    typeof model !== "string" ||
    model.length === 0 ||
    model.length > 256 ||
    !/\S/.test(model)
  ) {
    problems.push("model: 必须是非空字符串，最多 256 字符。");
  }

  const messages = value.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    problems.push("messages: 至少需要一条消息。");
  } else {
    messages.forEach((message, index) => {
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        problems.push(`messages.${index}: 必须是对象。`);
        return;
      }
      const item = message as Record<string, unknown>;
      if (typeof item.role !== "string" || !ROLES.has(item.role)) {
        problems.push(`messages.${index}.role: 不受支持的角色。`);
      }
      if (
        item.content !== undefined &&
        item.content !== null &&
        typeof item.content !== "string" &&
        !Array.isArray(item.content)
      ) {
        problems.push(`messages.${index}.content: 必须是字符串、数组或 null。`);
      }
    });
  }

  if (value.stream !== undefined && typeof value.stream !== "boolean") {
    problems.push("stream: 必须是布尔值。");
  }
  for (const field of ["max_completion_tokens", "max_tokens"] as const) {
    const limit = value[field];
    if (limit !== undefined && limit !== null && (!Number.isInteger(limit) || (limit as number) <= 0)) {
      problems.push(`${field}: 必须为正整数。`);
    }
  }
  if (problems.length > 0) invalid(problems);
  return value as ChatCompletionRequest;
}

/** Callers must never forward credentials embedded in the request body. */
export function stripCredentialFields(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const copy = { ...body };
  for (const name of Object.keys(copy)) {
    if (CREDENTIAL_FIELDS.has(name.toLowerCase())) delete copy[name];
  }
  return copy;
}

/** Sorted-key JSON keeps the derived identity stable across turns. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
