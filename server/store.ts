import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { RelayError } from "./errors";

export const SESSION_COOKIE = "relay_session";
export const SESSION_SECONDS = 7 * 24 * 60 * 60;

interface ConfigRow {
  api_key_hash: string | null;
  api_key_prefix: string | null;
  key_created_at: number | null;
  key_updated_at: number | null;
  upstream_api_key: string | null;
}

export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Single API key, upstream credential and hashed browser sessions in SQLite. */
export class ConfigStore {
  readonly db: Database;

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
    const path = join(dataDir, "relay.sqlite3");
    this.db = new Database(path);
    this.db.exec("PRAGMA busy_timeout = 10000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        api_key_hash TEXT,
        api_key_prefix TEXT,
        key_created_at INTEGER,
        key_updated_at INTEGER,
        upstream_api_key TEXT
      );
      INSERT OR IGNORE INTO config (id) VALUES (1);
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      );
    `);
    if (initialApiKey) {
      const now = Math.floor(Date.now() / 1000);
      this.db
        .query(
          "UPDATE config SET api_key_hash=?, api_key_prefix=?, key_created_at=?, key_updated_at=? " +
            "WHERE id=1 AND api_key_hash IS NULL",
        )
        .run(
          digest(initialApiKey),
          initialApiKey.slice(0, Math.min(10, Math.floor(initialApiKey.length / 3))),
          now,
          now,
        );
    }
    try {
      chmodSync(path, 0o600);
    } catch {
      /* Windows ignores POSIX modes. */
    }
  }

  snapshot(): ConfigRow {
    return this.db.query("SELECT * FROM config WHERE id=1").get() as ConfigRow;
  }

  keyExists(): boolean {
    return this.snapshot().api_key_hash !== null;
  }

  verifyKey(key: string): boolean {
    const expected = this.snapshot().api_key_hash;
    return Boolean(key && expected && digest(key) === expected);
  }

  private sessionIn(token: string): boolean {
    return Boolean(
      token &&
        this.db
          .query("SELECT 1 FROM sessions WHERE token_hash=? AND expires_at>?")
          .get(digest(token), Math.floor(Date.now() / 1000)),
    );
  }

  verifySession(token: string): boolean {
    return this.sessionIn(token);
  }

  login(key: string, currentToken = ""): string {
    const tx = this.db.transaction(() => {
      const expected = this.snapshot().api_key_hash;
      if (currentToken && this.sessionIn(currentToken) && !key) return currentToken;
      if (expected && digest(key) !== expected) {
        throw new RelayError("调用 API Key 无效，请输入已创建的密钥。", 401, "invalid_api_key");
      }
      const token = randomBytes(32).toString("base64url");
      const now = Math.floor(Date.now() / 1000);
      this.db.query("DELETE FROM sessions WHERE expires_at<=?").run(now);
      this.db.query("INSERT INTO sessions VALUES (?, ?)").run(digest(token), now + SESSION_SECONDS);
      return token;
    });
    return tx.immediate();
  }

  logout(token: string): void {
    this.db.query("DELETE FROM sessions WHERE token_hash=?").run(digest(token));
  }

  issueKey(token: string, rotate = false): string {
    const tx = this.db.transaction(() => {
      if (!this.sessionIn(token)) {
        throw new RelayError("管理会话已失效，请重新登录。", 401, "session_expired");
      }
      const exists = this.snapshot().api_key_hash;
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
      this.db
        .query(
          "UPDATE config SET api_key_hash=?, api_key_prefix=?, " +
            "key_created_at=COALESCE(key_created_at, ?), key_updated_at=? WHERE id=1",
        )
        .run(digest(key), key.slice(0, 17), now, now);
      // The current browser keeps access; every other session must use the new key.
      this.db.query("DELETE FROM sessions WHERE token_hash<>?").run(digest(token));
      return key;
    });
    return tx.immediate();
  }

  saveUpstream(token: string, key: string): void {
    const tx = this.db.transaction(() => {
      if (!this.sessionIn(token)) {
        throw new RelayError("管理会话已失效，请重新登录。", 401, "session_expired");
      }
      this.db.query("UPDATE config SET upstream_api_key=? WHERE id=1").run(key || "public");
    });
    tx.immediate();
  }

  upstreamKey(fallback: string): string {
    return this.snapshot().upstream_api_key || fallback || "public";
  }

  publicSettings(defaultUpstream: string) {
    const row = this.snapshot();
    const effective = row.upstream_api_key || defaultUpstream || "public";
    return {
      api_key: {
        exists: row.api_key_hash !== null,
        prefix: row.api_key_prefix,
        created_at: row.key_created_at,
        updated_at: row.key_updated_at,
      },
      upstream: { configured: effective !== "public" },
    };
  }

  close(): void {
    this.db.close();
  }
}
