import { join } from "node:path";

export const ROOT = join(import.meta.dir, "..");

export interface Settings {
  port: number;
  opencodeApiKey: string;
  opencodeBaseUrl: string;
  opencodeModelsUrl?: string;
  opencodeClient: string;
  opencodeVersion: string;
  timeoutSeconds: number;
  maxConcurrent: number;
  relayApiKey?: string;
  dataDir: string;
  development: boolean;
}

function integer(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function seconds(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/** Environment first, explicit overrides last (tests use overrides). */
export function loadSettings(overrides: Partial<Settings> = {}): Settings {
  const env = process.env;
  const base: Settings = {
    port: integer(env.PORT, 8948, 0, 65535),
    opencodeApiKey: env.OPENCODE_API_KEY || "public",
    opencodeBaseUrl: (env.OPENCODE_BASE_URL || "https://opencode.ai/inference/openai/v1").replace(/\/+$/, ""),
    opencodeModelsUrl: env.OPENCODE_MODELS_URL?.trim() || undefined,
    opencodeClient: env.OPENCODE_CLIENT || "cli",
    opencodeVersion: env.OPENCODE_VERSION || "2.1.1",
    timeoutSeconds: seconds(env.OPENCODE_TIMEOUT_SECONDS, 120, 0.001, 1800),
    maxConcurrent: integer(env.OPENCODE_MAX_CONCURRENT_REQUESTS, 8, 1, 128),
    relayApiKey: env.RELAY_API_KEY || undefined,
    dataDir: env.RELAY_DATA_DIR || join(ROOT, "data"),
    development: env.NODE_ENV !== "production",
  };
  const defined = Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined),
  ) as Partial<Settings>;
  return { ...base, ...defined };
}
