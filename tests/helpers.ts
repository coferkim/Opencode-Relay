import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp, type RelayApp } from "../server/app";
import type { Settings } from "../server/config";

export interface TestApp extends RelayApp {
  url: string;
  dataDir: string;
}

export function startApp(overrides: Partial<Settings> = {}): TestApp {
  const dataDir =
    overrides.dataDir ?? mkdtempSync(join(tmpdir(), "opencode-relay-"));
  const app = createApp({
    settings: { port: 0, development: false, dataDir, ...overrides },
  });
  return Object.assign(app, {
    url: `http://127.0.0.1:${app.server.port}`,
    dataDir,
  });
}

/** Minimal cookie-keeping client, enough for one Set-Cookie per response. */
export class Browser {
  cookie = "";

  constructor(readonly app: TestApp) {}

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookie) headers.set("cookie", this.cookie);
    const response = await fetch(`${this.app.url}${path}`, { ...init, headers });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) {
      this.cookie = setCookie.split(";")[0] ?? "";
    }
    return response;
  }

  get(path: string, init: RequestInit = {}): Promise<Response> {
    return this.request(path, { ...init, method: "GET" });
  }

  post(path: string, body?: unknown, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (body !== undefined) headers.set("content-type", "application/json");
    return this.request(path, {
      ...init,
      method: "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  put(path: string, body: unknown, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("content-type", "application/json");
    return this.request(path, {
      ...init,
      method: "PUT",
      headers,
      body: JSON.stringify(body),
    });
  }

  delete(path: string, init: RequestInit = {}): Promise<Response> {
    return this.request(path, { ...init, method: "DELETE" });
  }
}

export function chatBody(
  model = "free-model",
  stream = false,
): Record<string, unknown> {
  return {
    model,
    messages: [{ role: "user", content: "你好" }],
    stream,
    max_tokens: 32,
  };
}

export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await Bun.sleep(20);
  }
  return predicate();
}
