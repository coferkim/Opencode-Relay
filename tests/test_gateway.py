"""Exercise FastAPI -> real Bun subprocess -> local HTTP upstream without quota use."""

import asyncio
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import ClassVar

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.config import Settings


class UpstreamHandler(BaseHTTPRequestHandler):
    requests: ClassVar[list[dict]] = []

    def log_message(self, *_args):
        pass

    def reply(self, status, body, content_type="application/json", extra_headers=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        if self.path != "/models":
            return self.reply(404, b"{}")
        self.requests.append({"headers": dict(self.headers), "body": None})
        self.reply(
            200,
            json.dumps(
                {
                    "data": [
                        {
                            "id": "free-model",
                            "name": "Free",
                            "api": {"chat-completions": {"path": "chat"}},
                            "cost": {"text": {"input": {"price": 0}, "output": {"price": 0}}},
                        },
                        {
                            "id": "paid-model",
                            "api": {"chat-completions": {"path": "chat"}},
                            "cost": {"text": {"input": {"price": 1}, "output": {"price": 2}}},
                        },
                        {"id": "image-only", "api": {"images": {"path": "images"}}},
                    ]
                }
            ).encode(),
        )

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.requests.append({"headers": dict(self.headers), "body": body})
        if body["model"] == "slow-headers":
            time.sleep(2)
        if body["model"] == "slow-stream":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            try:
                self.wfile.write(b'data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n')
                self.wfile.flush()
                time.sleep(2)
                self.wfile.write(b"data: [DONE]\n\n")
            except (BrokenPipeError, ConnectionResetError):
                pass
            return
        if body["model"] == "unauthorized":
            return self.reply(
                401,
                b'{"error":{"message":"Invalid upstream credential","type":"authentication_error"}}',
                extra_headers={"x-relay-auth-error": "1"},
            )
        if body["model"] == "rate-limit":
            return self.reply(
                429,
                b'{"error":{"message":"quota exceeded","type":"rate_limit_error"}}',
                extra_headers={"retry-after": "7"},
            )
        if body["model"] == "html-error":
            return self.reply(502, b"upstream unavailable", "text/html")
        if body["model"] == "tool-model":
            deltas = [
                {
                    "role": "assistant",
                    "tool_calls": [
                        {
                            "index": 0,
                            "id": "call_1",
                            "type": "function",
                            "function": {"name": "read", "arguments": '{"path":'},
                        }
                    ],
                },
                {"tool_calls": [{"index": 0, "function": {"arguments": '"test.txt"}'}}]},
            ]
            finish = "tool_calls"
        else:
            deltas = [
                {"role": "assistant", "reasoning_content": "思考"},
                {"content": "你好"},
                {"content": "，Bun！"},
            ]
            finish = "length" if body["model"] == "length-model" else "stop"
        events = []
        for delta in deltas:
            events.append(
                {
                    "id": "chatcmpl-test",
                    "object": "chat.completion.chunk",
                    "created": 1,
                    "model": body["model"],
                    "choices": [{"index": 0, "delta": delta, "finish_reason": None}],
                }
            )
        events.append({"choices": [{"index": 0, "delta": {}, "finish_reason": finish}]})
        events.append(
            {
                "choices": [],
                "usage": {"prompt_tokens": 3, "completion_tokens": 5, "total_tokens": 8},
            }
        )
        encoded = (
            ": heartbeat\r\n\r\n"
            + "".join(f"data: {json.dumps(event, ensure_ascii=False)}\r\n\r\n" for event in events)
            + "data: [DONE]\r\n\r\n"
        )
        if body["model"] == "truncated":
            encoded = f"data: {json.dumps(events[0])}\n\n"
        self.reply(
            200,
            encoded.encode("utf-8"),
            "text/event-stream",
            {"x-zen-model": body["model"], "x-opencode-log-id": "test-log-id"},
        )


@pytest.fixture(scope="module")
def upstream():
    server = ThreadingHTTPServer(("127.0.0.1", 0), UpstreamHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_port}"
    server.shutdown()
    server.server_close()
    thread.join()


@pytest.fixture
def client(upstream):
    settings = Settings(opencode_base_url=upstream, opencode_api_key="test-key", _env_file=None)
    with TestClient(create_app(settings)) as client:
        assert client.post("/api/session", json={}).status_code == 200
        yield client


def chat_body(model="free-model", stream=False):
    return {
        "model": model,
        "messages": [{"role": "user", "content": "你好"}],
        "stream": stream,
        "max_tokens": 32,
    }


def test_live_catalog_filters_non_chat_models(client):
    response = client.get("/v1/models")
    assert response.status_code == 200
    assert [model["id"] for model in response.json()["data"]] == ["free-model", "paid-model"]
    assert [model["id"] for model in client.get("/v1/models?free_only=true").json()["data"]] == [
        "free-model"
    ]


def test_nonstream_aggregation_and_native_request(client):
    response = client.post("/v1/chat/completions", json=chat_body())
    assert response.status_code == 200
    result = response.json()
    assert result["object"] == "chat.completion"
    assert result["choices"][0]["message"]["content"] == "你好，Bun！"
    assert result["choices"][0]["message"]["reasoning_content"] == "思考"
    assert result["usage"]["total_tokens"] == 8
    assert response.headers["x-zen-model"] == "free-model"
    request = UpstreamHandler.requests[-1]
    body = request["body"]
    assert body["stream"] is True
    assert body["stream_options"]["include_usage"] is True
    assert body["max_completion_tokens"] == 32
    assert "max_tokens" not in body
    assert "Working directory:" in body["messages"][0]["content"]
    assert any(tool["function"]["name"] == "read" for tool in body["tools"])
    headers = {key.lower(): value for key, value in request["headers"].items()}
    assert headers["authorization"] == "Bearer test-key"
    assert headers["x-opencode-client"] == "desktop"
    assert headers["x-opencode-session"] == headers["x-session-affinity"]


def test_conversation_reuses_upstream_identity(client):
    first = chat_body()
    client.post("/v1/chat/completions", json=first)
    first_headers = {k.lower(): v for k, v in UpstreamHandler.requests[-1]["headers"].items()}
    second = chat_body()
    second["messages"].append({"role": "assistant", "content": "earlier reply"})
    second["messages"].append({"role": "user", "content": "follow-up"})
    client.post("/v1/chat/completions", json=second)
    second_headers = {k.lower(): v for k, v in UpstreamHandler.requests[-1]["headers"].items()}
    assert first_headers["x-opencode-session"] == second_headers["x-opencode-session"]
    assert first_headers["x-opencode-project"] == second_headers["x-opencode-project"]
    changed = chat_body()
    changed["messages"][-1]["content"] = "different conversation"
    client.post("/v1/chat/completions", json=changed)
    changed_headers = {k.lower(): v for k, v in UpstreamHandler.requests[-1]["headers"].items()}
    assert changed_headers["x-opencode-session"] != first_headers["x-opencode-session"]


def test_stream_is_forwarded_with_done_and_usage(client):
    with client.stream("POST", "/v1/chat/completions", json=chat_body(stream=True)) as response:
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        result = "".join(response.iter_text())
    assert "data: [DONE]" in result
    assert "completion_tokens" in result
    assert "你好" in result
    assert client.app.state.bridge.processes == set()


def test_tool_calls_and_finish_reason_are_preserved(client):
    result = client.post("/v1/chat/completions", json=chat_body("tool-model")).json()
    choice = result["choices"][0]
    assert choice["finish_reason"] == "tool_calls"
    tool = choice["message"]["tool_calls"][0]
    assert tool["id"] == "call_1"
    assert tool["function"] == {"name": "read", "arguments": '{"path":"test.txt"}'}
    result = client.post("/v1/chat/completions", json=chat_body("length-model")).json()
    assert result["choices"][0]["finish_reason"] == "length"


@pytest.mark.parametrize("stream", [True, False])
def test_upstream_errors_keep_http_status(client, stream):
    response = client.post("/v1/chat/completions", json=chat_body("rate-limit", stream))
    assert response.status_code == 429
    assert response.headers["retry-after"] == "7"
    assert response.json()["error"]["message"] == "quota exceeded"
    response = client.post("/v1/chat/completions", json=chat_body("html-error", stream))
    assert response.status_code == 502
    assert response.json()["error"]["message"] == "upstream unavailable"
    response = client.post("/v1/chat/completions", json=chat_body("unauthorized", stream))
    assert response.status_code == 401
    assert "x-relay-auth-error" not in response.headers


def test_truncated_nonstream_does_not_claim_success(client):
    response = client.post("/v1/chat/completions", json=chat_body("truncated"))
    assert response.status_code == 502
    assert "ended before completion" in response.json()["error"]["message"]


def test_invalid_requests_have_openai_error_shape(client):
    for payload in ({}, {"model": "x", "messages": []}, {**chat_body(), "max_tokens": 0}):
        response = client.post("/v1/chat/completions", json=payload)
        assert response.status_code == 400
        assert response.json()["error"]["type"] == "invalid_request_error"


def test_optional_relay_auth(upstream):
    settings = Settings(opencode_base_url=upstream, relay_api_key="relay-test", _env_file=None)
    with TestClient(create_app(settings)) as client:
        assert client.get("/api/health").json()["auth_required"] is True
        response = client.get("/v1/models")
        assert response.status_code == 401
        assert response.headers["x-relay-auth-error"] == "1"
        response = client.get("/v1/models", headers={"Authorization": "Bearer wrong"})
        assert response.status_code == 401
        assert response.headers["x-relay-auth-error"] == "1"
        assert (
            client.get("/v1/models", headers={"Authorization": "Bearer relay-test"}).status_code
            == 200
        )


def test_upstream_key_override_is_no_longer_accepted(client):
    count = len(UpstreamHandler.requests)
    response = client.get("/v1/models", headers={"X-OpenCode-API-Key": "bad key"})
    assert response.status_code == 400
    assert "bad key" not in response.text
    assert len(UpstreamHandler.requests) == count


def test_missing_bun_is_actionable(upstream):
    settings = Settings(
        opencode_base_url=upstream, bun_executable="missing-bun-for-test", _env_file=None
    )
    with TestClient(create_app(settings)) as client:
        assert client.post("/api/session", json={}).status_code == 200
        result = client.get("/v1/models")
        assert result.status_code == 503
        assert result.json()["error"]["code"] == "bun_missing"


@pytest.mark.parametrize(
    "model,stream",
    [
        ("slow-headers", True),
        ("slow-headers", False),
        ("slow-stream", True),
        ("slow-stream", False),
    ],
)
@pytest.mark.parametrize("spec_version", ["2.3", "2.4"])
def test_disconnect_cancels_bun_before_and_after_headers(upstream, model, stream, spec_version):
    async def run():
        app = create_app(
            Settings(opencode_base_url=upstream, relay_api_key="disconnect-key", _env_file=None)
        )
        body = json.dumps(chat_body(model, stream)).encode()
        incoming = asyncio.Queue()
        await incoming.put({"type": "http.request", "body": body, "more_body": False})
        sent = []

        async def send(message):
            sent.append(message)

        scope = {
            "type": "http",
            "asgi": {"version": "3.0", "spec_version": spec_version},
            "http_version": "1.1",
            "method": "POST",
            "scheme": "http",
            "path": "/v1/chat/completions",
            "raw_path": b"/v1/chat/completions",
            "query_string": b"",
            "root_path": "",
            "headers": [
                (b"content-type", b"application/json"),
                (b"authorization", b"Bearer disconnect-key"),
            ],
            "client": ("127.0.0.1", 1234),
            "server": ("127.0.0.1", 8949),
        }
        task = asyncio.create_task(app(scope, incoming.get, send))
        for _ in range(150):
            has_process = bool(app.state.bridge.processes)
            has_body = any(message["type"] == "http.response.body" for message in sent)
            if has_process and (not stream or model == "slow-headers" or has_body):
                break
            await asyncio.sleep(0.01)
        assert app.state.bridge.processes, "The real Bun subprocess must start before disconnect"
        await incoming.put({"type": "http.disconnect"})
        await asyncio.wait_for(task, timeout=0.75)
        assert app.state.bridge.processes == set()

    asyncio.run(run())


def test_upstream_timeout_is_504(upstream):
    settings = Settings(opencode_base_url=upstream, opencode_timeout_seconds=0.15, _env_file=None)
    with TestClient(create_app(settings)) as client:
        assert client.post("/api/session", json={}).status_code == 200
        response = client.post("/v1/chat/completions", json=chat_body("slow-headers"))
        assert response.status_code == 504
        assert response.json()["error"]["code"] == "upstream_timeout"
        assert client.app.state.bridge.processes == set()
