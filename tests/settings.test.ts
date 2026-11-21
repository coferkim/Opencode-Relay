import { Database } from "bun:sqlite";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, test } from "bun:test";

import type { Settings } from "../server/config";
import { ConfigStore } from "../server/store";
import { Browser, chatBody, startApp, type TestApp } from "./helpers";
import { startUpstream } from "./upstream";

const upstream = startUpstream();
const apps: TestApp[] = [];

function makeApp(overrides: Partial<Settings> = {}): TestApp {
  const app = startApp({
    opencodeBaseUrl: upstream.url,
    opencodeApiKey: "public",
    ...overrides,
  });
  apps.push(app);
  return app;
}

afterEach(() => {
  for (const app of apps.splice(0)) app.stop();
  upstream.reset();
});
afterAll(() => upstream.stop());

async function bootstrap(browser: Browser): Promise<void> {
  const response = await browser.post("/api/session", {});
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")!.toLowerCase();
  expect(cookie).toContain("httponly");
  expect(cookie).toContain("samesite=strict");
}

describe("settings and sessions", () => {
  test("first browser can use free models but anonymous clients cannot", async () => {
    const app = makeApp();
    const browser = new Browser(app);
    expect((await browser.get("/api/health")).status).toBe(200);
    expect(await (await browser.get("/api/session")).json()).toEqual({
      authenticated: false,
      api_key_created: false,
    });
    expect((await browser.get("/v1/models")).status).toBe(401);
    expect((await browser.get("/api/settings")).status).toBe(401);
    expect((await browser.post("/api/settings/api-key")).status).toBe(401);

    await bootstrap(browser);
    expect((await browser.get("/v1/models")).status).toBe(200);
    expect(upstream.requests.at(-1)!.headers.authorization).toBe("Bearer public");
  });

  test("only one key exists and external auth never uses the upstream key", async () => {
    const app = makeApp();
    const browser = new Browser(app);
    await bootstrap(browser);

    const created = await browser.post("/api/settings/api-key");
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toBe("no-store");
    const key = (await created.json()).api_key as string;
    expect(key.startsWith("sk-relay-")).toBe(true);
    expect(key.length).toBeGreaterThanOrEqual(48);
    expect((await browser.post("/api/settings/api-key")).status).toBe(409);

    const metadata = await browser.get("/api/settings");
    const metadataText = await metadata.text();
    expect(JSON.parse(metadataText).api_key.exists).toBe(true);
    expect(metadataText).not.toContain(key);
    expect(JSON.stringify(app.store.snapshot())).not.toContain(key);

    await browser.delete("/api/session");
    expect((await browser.get("/v1/models")).status).toBe(401);
    for (const invalid of ["public", "some-opencode-key", "wrong"]) {
      expect(
        (
          await browser.get("/v1/models", {
            headers: { authorization: `Bearer ${invalid}` },
          })
        ).status,
      ).toBe(401);
    }

    const chat = await browser.post("/v1/chat/completions", chatBody(), {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(chat.status).toBe(200);
    expect(upstream.requests.at(-1)!.headers.authorization).toBe("Bearer public");
    expect(JSON.stringify(upstream.requests.at(-1))).not.toContain(key);

    expect((await browser.post("/api/session", {})).status).toBe(401);
    expect((await browser.post("/api/session", { api_key: key })).status).toBe(200);
    expect(await (await browser.get("/api/settings")).text()).not.toContain(key);
  });

  test("concurrent key creation is atomic", async () => {
    const app = makeApp();
    const browser = new Browser(app);
    await bootstrap(browser);
    const token = browser.cookie;

    const statuses = await Promise.all(
      Array.from({ length: 8 }, () =>
        fetch(`${app.url}/api/settings/api-key`, {
          method: "POST",
          headers: { cookie: token, "content-type": "application/json" },
          body: "{}",
        }).then((response) => response.status),
      ),
    );
    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    expect(statuses.filter((status) => status === 409)).toHaveLength(7);

    const db = new Database(join(app.dataDir, "relay.sqlite3"));
    expect(db.query("SELECT COUNT(*) AS n FROM config").get()).toEqual({ n: 1 });
    expect(() => db.exec("INSERT INTO config (id) VALUES (2)")).toThrow();
    db.close();
  });

  test("rotation revokes the old key and other sessions", async () => {
    const app = makeApp();
    const browser = new Browser(app);
    await bootstrap(browser);
    const old = (await (await browser.post("/api/settings/api-key")).json()).api_key as string;

    const other = new Browser(app);
    expect((await other.post("/api/session", { api_key: old })).status).toBe(200);

    const rotated = await browser.post("/api/settings/api-key/rotate");
    const fresh = (await rotated.json()).api_key as string;
    expect(fresh).not.toBe(old);
    expect((await other.get("/api/settings")).status).toBe(401);
    expect(
      (
        await other.get("/v1/models", {
          headers: { authorization: `Bearer ${old}` },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await other.get("/v1/models", {
          headers: { authorization: `Bearer ${fresh}` },
        })
      ).status,
    ).toBe(200);
    expect((await browser.get("/api/settings")).status).toBe(200);
    expect((await browser.post("/api/settings/api-key")).status).toBe(409);

    // An old environment variable must never restore the old key after a restart.
    const restored = new ConfigStore(app.dataDir, old);
    expect(restored.verifyKey(old)).toBe(false);
    expect(restored.verifyKey(fresh)).toBe(true);
    restored.close();
  });

  test("key creation revokes other anonymous bootstrap sessions", async () => {
    const app = makeApp();
    const browser = new Browser(app);
    const other = new Browser(app);
    await bootstrap(browser);
    await bootstrap(other);
    expect((await browser.post("/api/settings/api-key")).status).toBe(201);
    expect(
      (await other.put("/api/settings/upstream", { api_key: "intruder" })).status,
    ).toBe(401);
    expect((await other.get("/v1/models")).status).toBe(401);
    expect((await browser.get("/api/settings")).status).toBe(200);
  });

  test("saved upstream key and sessions survive a restart", async () => {
    const app = makeApp();
    const browser = new Browser(app);
    await bootstrap(browser);
    const relayKey = (
      await (await browser.post("/api/settings/api-key")).json()
    ).api_key as string;
    const saved = await browser.put("/api/settings/upstream", {
      api_key: "paid-upstream-secret",
    });
    expect(saved.status).toBe(200);
    const savedText = await saved.text();
    expect(JSON.parse(savedText).upstream.configured).toBe(true);
    expect(savedText).not.toContain("paid-upstream-secret");
    const session = browser.cookie;
    app.stop();

    const restarted = makeApp({ dataDir: app.dataDir });
    const after = new Browser(restarted);
    after.cookie = session;
    const settings = await after.get("/api/settings");
    expect(settings.status).toBe(200);
    expect((await settings.json()).upstream.configured).toBe(true);

    const chat = await after.post("/v1/chat/completions", chatBody(), {
      headers: { authorization: `Bearer ${relayKey}` },
    });
    expect(chat.status).toBe(200);
    expect(upstream.requests.at(-1)!.headers.authorization).toBe(
      "Bearer paid-upstream-secret",
    );
    expect(await chat.text()).not.toContain("paid-upstream-secret");
    expect(
      (
        await after.get("/v1/models", {
          headers: { authorization: "Bearer paid-upstream-secret" },
        })
      ).status,
    ).toBe(401);

    const reset = await after.put("/api/settings/upstream", { api_key: "" });
    expect((await reset.json()).upstream.configured).toBe(false);
    expect((await after.get("/v1/models")).status).toBe(200);
    expect(upstream.requests.at(-1)!.headers.authorization).toBe("Bearer public");
  });

  test("management rejects cross-origin requests", async () => {
    const app = makeApp();
    const browser = new Browser(app);
    await bootstrap(browser);
    const origin = `http://127.0.0.1:${app.server.port}`;

    for (const path of [
      "/api/session",
      "/api/settings/api-key",
      "/api/settings/upstream",
    ]) {
      const method = path.endsWith("upstream") ? "PUT" : "POST";
      const call = (headers: Record<string, string>) =>
        browser.request(path, {
          method,
          headers: { "content-type": "application/json", ...headers },
          body: "{}",
        });
      expect((await call({ origin: "https://evil.invalid" })).status).toBe(403);
      expect((await call({ "sec-fetch-site": "same-site" })).status).toBe(403);
      expect([200, 201]).toContain((await call({ origin })).status);
    }
  });

  test("validation and expiry never leak secrets", async () => {
    const app = makeApp();
    const browser = new Browser(app);
    expect(
      (await browser.put("/api/settings/upstream", { api_key: "private-upstream" }))
        .status,
    ).toBe(401);
    await bootstrap(browser);

    for (const invalid of ["bad key", "secret\u0000value", "中中中", "x".repeat(4097)]) {
      const response = await browser.put("/api/settings/upstream", {
        api_key: invalid,
      });
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain(invalid);
    }
    expect((await (await browser.get("/api/settings")).json()).upstream.configured).toBe(
      false,
    );

    const key = (await (await browser.post("/api/settings/api-key")).json())
      .api_key as string;
    expect(
      (
        await browser.get("/v1/models", {
          headers: { authorization: "Bearer invalid" },
        })
      ).status,
    ).toBe(401);

    const db = new Database(join(app.dataDir, "relay.sqlite3"));
    db.exec("UPDATE sessions SET expires_at=0");
    db.close();

    expect((await browser.get("/api/settings")).status).toBe(401);
    expect((await browser.get("/v1/models")).status).toBe(401);
    expect(
      (
        await browser.get("/v1/models", {
          headers: { authorization: `Bearer ${key}` },
        })
      ).status,
    ).toBe(200);
  });

  test("secure cookie is set behind HTTPS", async () => {
    const app = makeApp();
    const browser = new Browser(app);
    const host = new URL(app.url).host;
    const response = await browser.post("/api/session", {}, {
      headers: { origin: `https://${host}`, "x-forwarded-proto": "https" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")!.toLowerCase()).toContain("secure");
  });

  test("upstream keys cannot be passed by external callers", async () => {
    const app = makeApp();
    const browser = new Browser(app);
    await bootstrap(browser);
    const key = (await (await browser.post("/api/settings/api-key")).json())
      .api_key as string;
    const auth = { authorization: `Bearer ${key}` };

    for (const path of [
      "/v1/models?api_key=should-not-forward",
      "/v1/models?opencode_api_key=secret",
    ]) {
      expect((await browser.get(path, { headers: auth })).status).toBe(400);
    }

    const payload = {
      ...chatBody(),
      api_key: "secret",
      opencode_api_key: "secret",
      authorization: "secret",
      Authorization: "Bearer secret",
    };
    expect(
      (await browser.post("/v1/chat/completions", payload, { headers: auth }))
        .status,
    ).toBe(200);
    const recorded = upstream.requests.at(-1)!.body;
    expect(
      Object.keys(recorded).some((name) =>
        ["api_key", "opencode_api_key", "authorization"].includes(name.toLowerCase()),
      ),
    ).toBe(false);
  });
});
