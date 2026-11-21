/**
 * Minimal structured logger. One line per event, key=value fields, so a
 * container's `docker logs` stays greppable. Levels: debug | info | warn |
 * error | off (RELAY_LOG_LEVEL, default info). Secrets never reach the log:
 * API keys are only ever printed through `maskKey`.
 */
export type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function configured(): number {
  const raw = (process.env.RELAY_LOG_LEVEL ?? "info").toLowerCase();
  if (raw === "off" || raw === "silent" || raw === "none") return 100;
  return ORDER[raw as Level] ?? ORDER.info;
}

const threshold = configured();

function emit(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  if (ORDER[level] < threshold) return;
  const parts = [`${new Date().toISOString()} ${level.padEnd(5)} ${event}`];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    parts.push(`${key}=${format(value)}`);
  }
  const line = parts.join(" ");
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

function format(value: unknown): string {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Error) return JSON.stringify(`${value.name}: ${value.message}`);
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return /[\s="]/.test(text) ? JSON.stringify(text) : text;
}

export const log = {
  debug: (event: string, fields?: Record<string, unknown>) => emit("debug", event, fields),
  info: (event: string, fields?: Record<string, unknown>) => emit("info", event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => emit("warn", event, fields),
  error: (event: string, fields?: Record<string, unknown>) => emit("error", event, fields),
};

/** Never log a credential; a short prefix is enough to tell keys apart. */
export function maskKey(key: string): string {
  if (!key) return "(empty)";
  if (key === "public") return "public";
  return `${key.slice(0, 6)}…(${key.length})`;
}

/** Session ids are safe to log in short form and useful for correlating turns. */
export function shortSession(id: string | null | undefined): string | undefined {
  if (!id) return undefined;
  return id.length > 12 ? `${id.slice(0, 12)}…` : id;
}
