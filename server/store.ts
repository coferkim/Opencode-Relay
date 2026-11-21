import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { RelayError } from "./errors";

export const SESSION_COOKIE = "relay_session";
export const SESSION_SECONDS = 7 * 24 * 60 * 60;

/** Config shard: the single relay key and the upstream credential. */
interface ConfigFile {
  version: 1;
  api_key: {
    hash: string | null;
    prefix: string | null;
    created_at: number | null;
    updated_at: number | null;
  };
  upstream_api_key: string | null;
}

/** Session shard: hashed browser sessions -> expiry (epoch seconds). */
interface SessionsFile {
  version: 1;
  sessions: Record<string, number>;
}

const CONFIG_FILE = "config.json";
const SESSIONS_FILE = "sessions.json";
const LEGACY_DB = "relay.sqlite3";

export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function emptyConfig(): ConfigFile {
  return {
    version: 1,
    api_key: { hash: null, prefix: null, created_at: null, updated_at: null },
    upstream_api_key: null,
  };
}

function emptySessions(): SessionsFile {
  return { version: 1, sessions: {} };
}

function readJson<T>(path: string, fallback: () => T): T {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as T;
  } catch {
    /* Missing or corrupt: start from the fallback. */
  }
  return fallback();
}

/** Write via a sibling temp file + rename so a crash cannot truncate the shard. */
function writeJson(path: string, value: unknown): void {
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(temp, 0o600);
  } catch {
    /* Windows ignores POSIX modes. */
  }
  renameSync(temp, path);
}

/**
 * One-time import of the pre-JSON SQLite store. The old file is renamed to
 * `relay.sqlite3.migrated` so a later start does not re-import stale data.
 */
function migrateLegacySqlite(dataDir: string, config: ConfigFile, sessions: SessionsFile): boolean {
  const legacy = join(dataDir, LEGACY_DB);
  if (!existsSync(legacy)) return false;
  try {
    // Built into Bun; imported lazily so a fresh install never loads it.
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
    const db = new Database(legacy, { readonly: true });
    try {
      const row = db.query("SELECT * FROM config WHERE id=1").get() as
        | {
            api_key_hash: string | null;
            api_key_prefix: string | null;
            key_created_at: number | null;
            key_updated_at: number | null;
            upstream_api_key: string | null;
          }
        | null;
      if (row) {
        config.api_key = {
          hash: row.api_key_hash,
          prefix: row.api_key_prefix,
          created_at: row.key_created_at,
          updated_at: row.key_updated_at,
        };
        config.upstream_api_key = row.upstream_api_key;
      }
      for (const session of db.query("SELECT token_hash, expires_at FROM sessions").all() as {
        token_hash: string;
        expires_at: number;
      }[]) {
        sessions.sessions[session.token_hash] = session.expires_at;
      }
    } finally {
      db.close();
    }
    renameSync(legacy, `${legacy}.migrated`);
    return true;
  } catch {
    // A locked or unreadable database must not block startup; the fresh
    // config takes over and the old file stays for manual recovery.
    return false;
  }
}

/**
 * Config and sessions in two JSON shards under the data directory:
 *
 *   config.json    single relay key (hashed), key metadata, upstream key
 *   sessions.json  hashed browser sessions -> expiry
 *
 * Writes are synchronous read-modify-write with a temp-file rename, so two
 * concurrent requests in the same process serialize on the event loop and a
 * crash mid-write leaves the previous shard intact. A legacy
 * `relay.sqlite3` from an earlier version is imported once, then renamed.
 */
export class ConfigStore {
  private config: ConfigFile;
  private sessions: SessionsFile;
  /** Last observed mtime+size per shard; a change means an external edit. */
  private stamps = new Map<string, string>();

  constructor(
    readonly dataDir: string,
    initialApiKey?: string | null,
  ) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dataDir, 0o700);
    } catch {
      /* Windows ignores POSIX modes. */
    }
    const configPath = join(dataDir, CONFIG_FILE);
    const sessionsPath = join(dataDir, SESSIONS_FILE);
    const fresh = !existsSync(configPath);
    this.config = readJson(configPath, emptyConfig);
    this.sessions = readJson(sessionsPath, emptySessions);
    if (fresh && migrateLegacySqlite(dataDir, this.config, this.sessions)) {
      writeJson(configPath, this.config);
      writeJson(sessionsPath, this.sessions);
    }
    if (initialApiKey && this.config.api_key.hash === null) {
      const now = Math.floor(Date.now() / 1000);
      this.config.api_key = {
        hash: digest(initialApiKey),
        prefix: initialApiKey.slice(0, Math.min(10, Math.floor(initialApiKey.length / 3))),
        created_at: now,
        updated_at: now,
      };
      writeJson(configPath, this.config);
    }
    // Drop expired sessions once at startup so the shard does not grow forever.
    if (this.pruneSessions()) writeJson(sessionsPath, this.sessions);
    // Materialize both shards on first start so operators have files to read
    // and edit, even before any key or session exists.
    if (!existsSync(configPath)) writeJson(configPath, this.config);
    if (!existsSync(sessionsPath)) writeJson(sessionsPath, this.sessions);
    this.stamps.set("config", this.stamp(configPath));
    this.stamps.set("sessions", this.stamp(sessionsPath));
  }

  private configPath(): string {
    return join(this.dataDir, CONFIG_FILE);
  }

  private sessionsPath(): string {
    return join(this.dataDir, SESSIONS_FILE);
  }

  private stamp(path: string): string {
    try {
      const stat = statSync(path);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return "missing";
    }
  }

  /**
   * Re-read a shard when its file changed underneath us. The shards are the
   * source of truth (operators edit config.json by hand, and tests rewrite
   * sessions.json), so every read path refreshes a stale in-memory copy.
   */
  private refresh(): void {
    for (const [path, key] of [
      [this.configPath(), "config"],
      [this.sessionsPath(), "sessions"],
    ] as const) {
      const stamp = this.stamp(path);
      if (this.stamps.get(key) === stamp) continue;
      this.stamps.set(key, stamp);
      if (key === "config") this.config = readJson(path, emptyConfig);
      else this.sessions = readJson(path, emptySessions);
    }
  }

  private saveConfig(): void {
    writeJson(this.configPath(), this.config);
    this.stamps.set("config", this.stamp(this.configPath()));
  }

  private saveSessions(): void {
    writeJson(this.sessionsPath(), this.sessions);
    this.stamps.set("sessions", this.stamp(this.sessionsPath()));
  }

  /** Remove expired entries; returns whether anything changed. */
  private pruneSessions(): boolean {
    const now = Math.floor(Date.now() / 1000);
    let changed = false;
    for (const [hash, expiresAt] of Object.entries(this.sessions.sessions)) {
      if (expiresAt <= now) {
        delete this.sessions.sessions[hash];
        changed = true;
      }
    }
    return changed;
  }

  /** The config shard in its pre-JSON row shape, for callers and tests. */
  snapshot(): {
    api_key_hash: string | null;
    api_key_prefix: string | null;
    key_created_at: number | null;
    key_updated_at: number | null;
    upstream_api_key: string | null;
  } {
    this.refresh();
    return {
      api_key_hash: this.config.api_key.hash,
      api_key_prefix: this.config.api_key.prefix,
      key_created_at: this.config.api_key.created_at,
      key_updated_at: this.config.api_key.updated_at,
      upstream_api_key: this.config.upstream_api_key,
    };
  }

  keyExists(): boolean {
    this.refresh();
    return this.config.api_key.hash !== null;
  }

  verifyKey(key: string): boolean {
    this.refresh();
    const expected = this.config.api_key.hash;
    return Boolean(key && expected && digest(key) === expected);
  }

  private sessionIn(token: string): boolean {
    this.refresh();
    if (!token) return false;
    const expiresAt = this.sessions.sessions[digest(token)];
    return typeof expiresAt === "number" && expiresAt > Math.floor(Date.now() / 1000);
  }

  verifySession(token: string): boolean {
    return this.sessionIn(token);
  }

  login(key: string, currentToken = ""): string {
    this.refresh();
    const expected = this.config.api_key.hash;
    if (currentToken && this.sessionIn(currentToken) && !key) return currentToken;
    if (expected && digest(key) !== expected) {
      throw new RelayError("调用 API Key 无效，请输入已创建的密钥。", 401, "invalid_api_key");
    }
    const token = randomBytes(32).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    this.pruneSessions();
    this.sessions.sessions[digest(token)] = now + SESSION_SECONDS;
    this.saveSessions();
    return token;
  }

  logout(token: string): void {
    this.refresh();
    const hash = digest(token);
    if (this.sessions.sessions[hash] === undefined) return;
    delete this.sessions.sessions[hash];
    this.saveSessions();
  }

  issueKey(token: string, rotate = false): string {
    this.refresh();
    if (!this.sessionIn(token)) {
      throw new RelayError("管理会话已失效，请重新登录。", 401, "session_expired");
    }
    const exists = this.config.api_key.hash;
    if (exists && !rotate) {
      throw new RelayError(
        "只能创建一条 API Key；需要更换时请重置现有密钥。",
        409,
        "key_exists",
      );
    }
    if (rotate && !exists) {
      throw new RelayError("尚未创建 API Key。", 409, "key_missing");
    }
    const key = `sk-relay-${randomBytes(32).toString("base64url")}`;
    const now = Math.floor(Date.now() / 1000);
    this.config.api_key = {
      hash: digest(key),
      prefix: key.slice(0, 17),
      created_at: this.config.api_key.created_at ?? now,
      updated_at: now,
    };
    // The current browser keeps access; every other session must use the new key.
    const keep = digest(token);
    for (const hash of Object.keys(this.sessions.sessions)) {
      if (hash !== keep) delete this.sessions.sessions[hash];
    }
    this.saveConfig();
    this.saveSessions();
    return key;
  }

  saveUpstream(token: string, key: string): void {
    this.refresh();
    if (!this.sessionIn(token)) {
      throw new RelayError("管理会话已失效，请重新登录。", 401, "session_expired");
    }
    this.config.upstream_api_key = key || "public";
    this.saveConfig();
  }

  upstreamKey(fallback: string): string {
    this.refresh();
    return this.config.upstream_api_key || fallback || "public";
  }

  publicSettings(defaultUpstream: string) {
    this.refresh();
    const effective = this.config.upstream_api_key || defaultUpstream || "public";
    return {
      api_key: {
        exists: this.config.api_key.hash !== null,
        prefix: this.config.api_key.prefix,
        created_at: this.config.api_key.created_at,
        updated_at: this.config.api_key.updated_at,
      },
      upstream: { configured: effective !== "public" },
    };
  }

  /** Shards are written on every mutation; nothing is held open. */
  close(): void {
    /* No handles to release. */
  }
}
