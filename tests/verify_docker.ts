/** End-to-end Docker check: singleton key, rotation, auth and volume persistence. */
export {};

const BASE = "http://127.0.0.1:8948";
let cookie = "";

async function request(
  path: string,
  method = "GET",
  data?: unknown,
  headers: Record<string, string> = {},
  useBrowser = true,
): Promise<{ status: number; body: any; headers: Headers }> {
  const requestHeaders = new Headers({
    "content-type": "application/json",
    origin: BASE,
    ...headers,
  });
  if (useBrowser && cookie) requestHeaders.set("cookie", cookie);
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: requestHeaders,
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0] ?? "";
  const text = await response.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* Keep plain text bodies. */
  }
  return { status: response.status, body, headers: response.headers };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Docker verification failed: ${message}`);
}

assert((await request("/v1/models", "GET", undefined, {}, false)).status === 401, "anonymous models");
assert((await request("/api/settings")).status === 401, "anonymous settings");
assert((await request("/api/session", "POST", {})).status === 200, "bootstrap login");

const created = await request("/api/settings/api-key", "POST");
assert(created.status === 201, "key creation");
const key = created.body.api_key as string;
assert((await request("/api/settings/api-key", "POST")).status === 409, "singleton key");
assert((await request("/api/settings/upstream", "PUT", { api_key: "docker-test-upstream" })).status === 200, "save upstream");
assert((await request("/api/settings")).body.upstream.configured === true, "upstream configured");
assert((await request("/api/settings/upstream", "PUT", { api_key: "" })).status === 200, "reset upstream");
assert(
  (await request("/v1/chat/completions", "POST", {}, { authorization: `Bearer ${key}` }, false)).status === 400,
  "bearer auth without upstream call",
);

Bun.spawnSync(
  ["docker", "compose", "up", "-d", "--force-recreate", "--wait", "--wait-timeout", "90"],
  { stdout: "inherit", stderr: "inherit" },
);

const persisted = await request("/api/settings");
assert(persisted.status === 200, "session survives restart");
assert(persisted.body.api_key.exists === true, "key survives restart");
assert(!JSON.stringify(persisted.body).includes(key), "key is not exposed");
assert((await request("/api/settings/api-key", "POST")).status === 409, "still one key");
assert(
  (await request("/v1/chat/completions", "POST", {}, { authorization: `Bearer ${key}` }, false)).status === 400,
  "old key still authenticates",
);

const rotated = await request("/api/settings/api-key/rotate", "POST");
assert(rotated.status === 200 && rotated.body.api_key !== key, "rotation");
assert(
  (await request("/v1/chat/completions", "POST", {}, { authorization: `Bearer ${key}` }, false)).status === 401,
  "old key revoked",
);
assert(
  (await request("/api/settings", "GET", undefined, { origin: "https://evil.invalid" })).status === 403,
  "cross-origin rejected",
);

console.log("Docker settings, singleton key, Bearer auth, rotation and volume persistence passed.");
