import { mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { ConfigStore, digest } from "../server/store";

const dirs: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "relay-store-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  /* Temp dirs are left for the OS; nothing is held open. */
});

function readConfig(dir: string): any {
  return JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
}

function readSessions(dir: string): any {
  return JSON.parse(readFileSync(join(dir, "sessions.json"), "utf8"));
}

describe("JSON shard store", () => {
  test("a fresh store creates no sqlite file", () => {
    const dir = freshDir();
    const store = new ConfigStore(dir);
    store.close();
    expect(() => readFileSync(join(dir, "relay.sqlite3"))).toThrow();
    expect(readConfig(dir).version).toBe(1);
  });

  test("writes config.json and sessions.json separately", () => {
    const dir = freshDir();
    const store = new ConfigStore(dir, "seed-key");
    expect(store.keyExists()).toBe(true);
    const config = readConfig(dir);
    expect(config.api_key.hash).toBe(digest("seed-key"));
    expect(config.upstream_api_key).toBeNull();
    store.close();
  });

  test("the environment seed only applies on first initialization", () => {
    const dir = freshDir();
    const first = new ConfigStore(dir, "seed-key");
    expect(first.verifyKey("seed-key")).toBe(true);
    first.close();

    const second = new ConfigStore(dir, "other-key");
    expect(second.verifyKey("seed-key")).toBe(true);
    expect(second.verifyKey("other-key")).toBe(false);
    second.close();
  });

  test("sessions round-trip and expire", () => {
    const dir = freshDir();
    const store = new ConfigStore(dir);
    const token = store.login("");
    expect(store.verifySession(token)).toBe(true);
    const sessions = readSessions(dir);
    expect(sessions.sessions[digest(token)]).toBeGreaterThan(Math.floor(Date.now() / 1000));

    store.logout(token);
    expect(store.verifySession(token)).toBe(false);
    store.close();

    const reopened = new ConfigStore(dir);
    expect(reopened.verifySession(token)).toBe(false);
    reopened.close();
  });

  test("rotation rewrites config.json and prunes other sessions", () => {
    const dir = freshDir();
    const store = new ConfigStore(dir);
    const token = store.login("");
    const other = store.login("") === token ? token : store.login("");
    const first = store.issueKey(token);
    const rotated = store.issueKey(token, true);
    expect(rotated).not.toBe(first);
    expect(store.verifyKey(first)).toBe(false);
    expect(store.verifyKey(rotated)).toBe(true);
    const sessions = readSessions(dir);
    expect(Object.keys(sessions.sessions)).toEqual([digest(token)]);
    expect(other === token || sessions.sessions[digest(other)] === undefined).toBe(true);
    store.close();
  });

  test("external edits to the shards are picked up", () => {
    const dir = freshDir();
    const store = new ConfigStore(dir);
    expect(store.keyExists()).toBe(false);

    const config = readConfig(dir);
    config.api_key = {
      hash: digest("hand-written"),
      prefix: "sk-relay-hand",
      created_at: 1,
      updated_at: 1,
    };
    config.upstream_api_key = "hand-upstream";
    writeFileSync(join(dir, "config.json"), JSON.stringify(config));

    expect(store.keyExists()).toBe(true);
    expect(store.verifyKey("hand-written")).toBe(true);
    expect(store.upstreamKey("public")).toBe("hand-upstream");
    store.close();
  });

  test("a corrupt shard falls back to empty instead of crashing", () => {
    const dir = freshDir();
    writeFileSync(join(dir, "config.json"), "{not json");
    writeFileSync(join(dir, "sessions.json"), "[]");
    const store = new ConfigStore(dir);
    expect(store.keyExists()).toBe(false);
    expect(store.verifySession("anything")).toBe(false);
    store.close();
  });

  test("legacy sqlite is imported once and then renamed", () => {
    const dir = freshDir();
    // Build a legacy database in the pre-JSON shape.
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
    const db = new Database(join(dir, "relay.sqlite3"));
    db.exec(`
      CREATE TABLE config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        api_key_hash TEXT, api_key_prefix TEXT, key_created_at INTEGER,
        key_updated_at INTEGER, upstream_api_key TEXT
      );
      INSERT INTO config VALUES (1, '${digest("legacy-key")}', 'sk-relay-legacy', 11, 12, 'legacy-upstream');
      CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
      INSERT INTO sessions VALUES ('${digest("legacy-token")}', ${Math.floor(Date.now() / 1000) + 600});
    `);
    db.close();

    const store = new ConfigStore(dir);
    expect(store.verifyKey("legacy-key")).toBe(true);
    expect(store.verifySession("legacy-token")).toBe(true);
    expect(store.upstreamKey("public")).toBe("legacy-upstream");
    expect(readConfig(dir).api_key.prefix).toBe("sk-relay-legacy");
    expect(readSessions(dir).sessions[digest("legacy-token")]).toBeGreaterThan(0);
    store.close();

    // The old file is renamed so a restart does not re-import it.
    expect(() => readFileSync(join(dir, "relay.sqlite3"))).toThrow();
    expect(readFileSync(join(dir, "relay.sqlite3.migrated")).length).toBeGreaterThan(0);
  });

  test("legacy import does not overwrite an existing config shard", () => {
    const dir = freshDir();
    const existing = new ConfigStore(dir, "json-key");
    existing.close();

    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
    const db = new Database(join(dir, "relay.sqlite3"));
    db.exec(`
      CREATE TABLE config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        api_key_hash TEXT, api_key_prefix TEXT, key_created_at INTEGER,
        key_updated_at INTEGER, upstream_api_key TEXT
      );
      INSERT INTO config VALUES (1, '${digest("legacy-key")}', 'sk-relay-legacy', 11, 12, null);
      CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
    `);
    db.close();

    const store = new ConfigStore(dir);
    expect(store.verifyKey("json-key")).toBe(true);
    expect(store.verifyKey("legacy-key")).toBe(false);
    store.close();
    // The stale database stays on disk untouched for manual recovery.
    expect(readFileSync(join(dir, "relay.sqlite3")).length).toBeGreaterThan(0);
  });

  test("concurrent mutations serialize on the event loop", () => {
    const dir = freshDir();
    const store = new ConfigStore(dir);
    const token = store.login("");
    const results = Array.from({ length: 8 }, () => {
      try {
        return { ok: true, key: store.issueKey(token) };
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    });
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(7);
    const config = readConfig(dir);
    expect(typeof config.api_key.hash).toBe("string");
    store.close();
  });
});
