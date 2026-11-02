"""Check browser administration, singleton keys and volume persistence through Nginx."""

import http.cookiejar
import json
import subprocess
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:8948"
cookies = http.cookiejar.CookieJar()
browser = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookies))


def request(path, method="GET", data=None, headers=None, use_browser=True):
    body = None if data is None else json.dumps(data).encode()
    req = urllib.request.Request(
        BASE + path,
        data=body,
        method=method,
        headers={"Content-Type": "application/json", "Origin": BASE, **(headers or {})},
    )
    opener = browser if use_browser else urllib.request.build_opener()
    try:
        with opener.open(req, timeout=10) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, json.load(error)


assert request("/v1/models", use_browser=False)[0] == 401
assert request("/api/settings")[0] == 401
assert request("/api/session", "POST", {})[0] == 200
status, data = request("/api/settings/api-key", "POST")
assert status == 201
key = data["api_key"]
assert request("/api/settings/api-key", "POST")[0] == 409
assert request("/api/settings/upstream", "PUT", {"api_key": "docker-test-upstream"})[0] == 200
assert request("/api/settings")[1]["upstream"]["configured"] is True
assert request("/api/settings/upstream", "PUT", {"api_key": ""})[0] == 200
# Invalid Chat input verifies Bearer authentication without making upstream requests.
assert (
    request("/v1/chat/completions", "POST", {}, {"Authorization": f"Bearer {key}"}, False)[0] == 400
)
subprocess.run(
    ["docker", "compose", "up", "-d", "--force-recreate", "--wait", "--wait-timeout", "90"],
    check=True,
)
status, data = request("/api/settings")
assert status == 200 and data["api_key"]["exists"]
assert key not in json.dumps(data)
assert request("/api/settings/api-key", "POST")[0] == 409
assert (
    request("/v1/chat/completions", "POST", {}, {"Authorization": f"Bearer {key}"}, False)[0] == 400
)
status, data = request("/api/settings/api-key/rotate", "POST")
assert status == 200 and data["api_key"] != key
assert (
    request("/v1/chat/completions", "POST", {}, {"Authorization": f"Bearer {key}"}, False)[0] == 401
)
assert request("/api/settings", headers={"Origin": "https://evil.invalid"})[0] == 403
print("Docker settings, singleton key, Bearer auth, rotation and volume persistence passed.")
