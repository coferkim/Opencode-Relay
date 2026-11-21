import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";

import { Browser, chatBody, startApp, type TestApp } from "./helpers";
import { startUpstream } from "./upstream";

const upstream = startUpstream();
let app: TestApp;
let browser: Browser;

beforeEach(async () => {
  upstream.reset();
  app = startApp({ opencodeBaseUrl: upstream.url, opencodeApiKey: "test-key" });
  browser = new Browser(app);
  expect((await browser.post("/api/session", {})).status).toBe(200);
});

afterEach(() => app.stop());
afterAll(() => upstream.stop());

describe("HTTP semantics", () => {
  test("health is public and reports the relay state", async () => {
    const response = await browser.get("/api/health");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      status: "ok",
      transport: "bun-native",
      auth_required: true,
      api_key_created: false,
    });
  });

  test("JSON responses carry an application/json content type", async () => {
    for (const path of ["/api/health", "/api/session", "/v1/models"]) {
      const response = await browser.get(path);
      expect(response.headers.get("content-type")).toContain("application/json");
    }
  });

  test("management responses are not cached", async () => {
    expect((await browser.get("/api/session")).headers.get("cache-control")).toBe("no-store");
    expect((await browser.get("/api/settings")).headers.get("cache-control")).toBe("no-store");
    const created = await browser.post("/api/settings/api-key");
    expect(created.headers.get("cache-control")).toBe("no-store");
  });

  test("auth failures are marked for the web client", async () => {
    const anonymous = startApp({ opencodeBaseUrl: upstream.url, relayApiKey: "relay-key" });
    try {
      const response = await new Browser(anonymous).get("/v1/models");
      expect(response.status).toBe(401);
      expect(response.headers.get("x-relay-auth-error")).toBe("1");
    } finally {
      anonymous.stop();
    }
  });

  test("upstream tracing headers are forwarded", async () => {
    const response = await browser.post("/v1/chat/completions", chatBody("free-model", true));
    expect(response.headers.get("x-opencode-log-id")).toBe("test-log-id");
    expect(response.headers.get("x-zen-model")).toBe("free-model");
  });

  test("HEAD on a GET route answers like GET without a body", async () => {
    const response = await fetch(`${app.url}/api/health`, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });

  test("non-API 404s stay plain; API 404s use the error envelope", async () => {
    const plain = await fetch(`${app.url}/definitely-not-here`);
    expect(plain.status).toBe(404);
    expect(plain.headers.get("content-type") ?? "").not.toContain("application/json");

    const api = await fetch(`${app.url}/api/definitely-not-here`);
    expect(api.status).toBe(404);
    const body = await api.json();
    expect(typeof body.error.message).toBe("string");
  });

  test("logout clears the session cookie and the server-side session", async () => {
    const response = await browser.delete("/api/session");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ authenticated: false });
    const cookie = response.headers.get("set-cookie")!.toLowerCase();
    expect(cookie).toContain("max-age=0");
    expect((await browser.get("/api/settings")).status).toBe(401);
    expect((await browser.get("/api/session")).json()).resolves.toMatchObject({
      authenticated: false,
    });
  });

  test("wrong-key login is a 401 and does not issue a session", async () => {
    const key = (await (await browser.post("/api/settings/api-key")).json()).api_key as string;
    const other = new Browser(app);
    expect((await other.post("/api/session", { api_key: "wrong" })).status).toBe(401);
    expect(other.cookie).toBe("");
    expect((await other.post("/api/session", { api_key: key })).status).toBe(200);
  });

  test("rejects an oversized body instead of buffering it", async () => {
    // Bun closes the socket once a body exceeds maxRequestBodySize; clients see
    // a reset rather than a 200. Either a reset or a 4xx counts as a rejection.
    let status = 0;
    let reset = false;
    try {
      const response = await fetch(`${app.url}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer whatever",
          cookie: browser.cookie,
        },
        body: JSON.stringify({
          model: "x",
          messages: [{ role: "user", content: "x".repeat(17 * 1024 * 1024) }],
        }),
      });
      status = response.status;
    } catch {
      reset = true;
    }
    expect(reset || status === 413 || status === 400 || status === 401).toBe(true);
  });

  test("concurrent chats are all served", async () => {
    const responses = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        browser.post("/v1/chat/completions", {
          model: "free-model",
          messages: [{ role: "user", content: `并发 ${index}` }],
        }),
      ),
    );
    for (const response of responses) expect(response.status).toBe(200);
    const bodies = await Promise.all(responses.map((response) => response.json()));
    for (const body of bodies) {
      expect(body.choices[0].message.content).toBe("你好，Bun！");
    }
  });

  test("a client disconnect does not poison later requests", async () => {
    const controller = new AbortController();
    const pending = browser
      .post("/v1/chat/completions", chatBody("slow-stream", true), {
        signal: controller.signal,
      })
      .catch(() => null);
    await Bun.sleep(50);
    controller.abort();
    await pending;

    const after = await browser.post("/v1/chat/completions", chatBody());
    expect(after.status).toBe(200);
    expect((await after.json()).choices[0].message.content).toBe("你好，Bun！");
  });
});
