import json
import secrets
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from typing import Annotated, Any, Literal

from fastapi import Depends, FastAPI, Header, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator
from starlette.types import Receive, Scope, Send

from .bridge import BunBridge, RelayError
from .config import ROOT, Settings
from .disconnect import CancelOnDisconnectMiddleware
from .store import SESSION_COOKIE, SESSION_SECONDS, ConfigStore


class KeyInput(BaseModel):
    api_key: SecretStr = SecretStr("")

    @field_validator("api_key")
    @classmethod
    def validate_key(cls, value: SecretStr) -> SecretStr:
        key = value.get_secret_value().strip()
        if len(key) > 4096 or any(not 33 <= ord(char) <= 126 for char in key):
            raise ValueError("API Key 必须为可见 ASCII 字符，最多 4096 字符")
        return SecretStr(key)


class ManagedStreamingResponse(StreamingResponse):
    def __init__(self, content, context: AbstractAsyncContextManager, headers: dict):
        super().__init__(content, media_type="text/event-stream", headers=headers)
        self.context = context

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            # Closing only the body generator is insufficient when disconnect happens in send().
            await self.context.__aexit__(None, None, None)


class Message(BaseModel):
    model_config = ConfigDict(extra="allow")
    role: Literal["system", "developer", "user", "assistant", "tool", "function"]
    content: str | list[dict[str, Any]] | None = None


class ChatRequest(BaseModel):
    model_config = ConfigDict(extra="allow")
    model: str = Field(min_length=1, max_length=256, pattern=r"\S")
    messages: list[Message] = Field(min_length=1)
    stream: bool = False
    max_completion_tokens: int | None = Field(default=None, gt=0)
    max_tokens: int | None = Field(default=None, gt=0)


def error_body(message: str, code: str, error_type: str = "api_error") -> dict:
    return {"error": {"message": message, "type": error_type, "param": None, "code": code}}


def is_chat_model(model: dict) -> bool:
    # The upstream catalog is richer than OpenAI's; exclude embeddings/image-only models.
    api = model.get("api")
    return bool(api.get("chat-completions")) if isinstance(api, dict) else True


def is_free_model(model: dict) -> bool:
    text_cost = (model.get("cost") or {}).get("text") or {}
    input_price = (text_cost.get("input") or {}).get("price")
    output_price = (text_cost.get("output") or {}).get("price")
    return input_price == 0 and output_price in (0, None)


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()
    bridge = BunBridge(settings)
    store = ConfigStore(settings.relay_data_dir, settings.relay_api_key)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        yield
        await bridge.close()

    app = FastAPI(title="OpenCode Relay", version="0.1.0", lifespan=lifespan)
    app.add_middleware(CancelOnDisconnectMiddleware)
    app.state.bridge = bridge
    app.state.store = store

    def same_origin(request: Request) -> None:
        origin = request.headers.get("origin")
        host = request.headers.get("host", "")
        if (origin and origin not in {f"http://{host}", f"https://{host}"}) or (
            request.headers.get("sec-fetch-site") not in (None, "same-origin", "none")
        ):
            raise RelayError("不允许跨站访问管理接口。", 403, "cross_origin_request")

    def browser_session(request: Request) -> str:
        same_origin(request)
        token = request.cookies.get(SESSION_COOKIE, "")
        if not store.verify_session(token):
            raise RelayError("请使用调用 API Key 登录设置页。", 401, "session_expired")
        return token

    async def authorize(
        request: Request, authorization: Annotated[str | None, Header()] = None
    ) -> None:
        # An explicit Bearer token must be valid even if this browser has a session cookie.
        if authorization is not None:
            scheme, _, key = authorization.partition(" ")
            allowed = scheme.lower() == "bearer" and store.verify_key(key)
        else:
            token = request.cookies.get(SESSION_COOKIE, "")
            allowed = store.verify_session(token)
            if allowed:
                same_origin(request)
        if not allowed:
            message = (
                "调用 API Key 无效。"
                if store.key_exists()
                else "请先在 Web 设置页创建调用 API Key。"
            )
            raise RelayError(message, 401, "invalid_api_key")
        if request.headers.get("x-opencode-api-key") is not None or any(
            name in request.query_params for name in ("api_key", "apikey", "opencode_api_key")
        ):
            raise RelayError(
                "请在 Web 设置页修改 OpenCode API Key；调用接口只需提供调用 API Key。",
                400,
                "upstream_key_not_allowed",
            )

    @app.exception_handler(RelayError)
    async def handle_relay_error(request: Request, exc: RelayError):
        # This marker distinguishes gateway authentication failures from upstream 401s.
        headers = {"X-Relay-Auth-Error": "1"} if exc.status == 401 else None
        return JSONResponse(
            error_body(exc.message, exc.code), status_code=exc.status, headers=headers
        )

    @app.exception_handler(RequestValidationError)
    async def handle_validation_error(request: Request, exc: RequestValidationError):
        problems = "; ".join(
            f"{'.'.join(str(part) for part in item['loc'][1:])}: {item['msg']}"
            for item in exc.errors()
        )
        return JSONResponse(
            error_body(problems, "invalid_request", "invalid_request_error"), status_code=400
        )

    def decode_json(body: bytes) -> dict:
        try:
            result = json.loads(body)
            if not isinstance(result, dict):
                raise TypeError("Expected JSON object")
            return result
        except (ValueError, TypeError, UnicodeDecodeError) as exc:
            raise RelayError(
                "上游返回了无效的 JSON 响应。", code="invalid_upstream_response"
            ) from exc

    async def upstream_error(response) -> JSONResponse:
        body = await response.read()
        try:
            data = json.loads(body)
            if not isinstance(data, dict) or not isinstance(data.get("error"), dict):
                raise TypeError("Expected error object")
        except (ValueError, TypeError, UnicodeDecodeError):
            data = error_body(
                body.decode("utf-8", errors="replace")[:1000] or "上游请求失败。",
                "upstream_error",
            )
        headers = {
            name: value
            for name, value in response.headers.items()
            if name.lower() != "x-relay-auth-error"
        }
        return JSONResponse(data, status_code=response.status, headers=headers)

    @app.get("/api/health")
    async def health():
        return {
            "status": "ok",
            "transport": "bun-native",
            "auth_required": True,
            "api_key_created": store.key_exists(),
        }

    @app.get("/api/session")
    async def session_status(request: Request, response: Response):
        response.headers["Cache-Control"] = "no-store"
        return {
            "authenticated": store.verify_session(request.cookies.get(SESSION_COOKIE, "")),
            "api_key_created": store.key_exists(),
        }

    @app.post("/api/session", dependencies=[Depends(same_origin)])
    async def login(payload: KeyInput, request: Request):
        token = store.login(
            payload.api_key.get_secret_value(), request.cookies.get(SESSION_COOKIE, "")
        )
        response = JSONResponse({"authenticated": True}, headers={"Cache-Control": "no-store"})
        response.set_cookie(
            SESSION_COOKIE,
            token,
            max_age=SESSION_SECONDS,
            httponly=True,
            samesite="strict",
            secure=request.url.scheme == "https"
            or request.headers.get("x-forwarded-proto") == "https"
            or request.headers.get("origin", "").startswith("https://"),
        )
        return response

    @app.delete("/api/session", dependencies=[Depends(same_origin)])
    async def logout(request: Request):
        store.logout(request.cookies.get(SESSION_COOKIE, ""))
        response = JSONResponse({"authenticated": False}, headers={"Cache-Control": "no-store"})
        response.delete_cookie(SESSION_COOKIE)
        return response

    @app.get("/api/settings", dependencies=[Depends(browser_session)])
    async def read_settings():
        return JSONResponse(
            store.public_settings(settings.opencode_api_key), headers={"Cache-Control": "no-store"}
        )

    @app.post("/api/settings/api-key")
    async def create_key(token: str = Depends(browser_session)):
        key = store.issue_key(token)
        return JSONResponse(
            {"api_key": key}, status_code=201, headers={"Cache-Control": "no-store"}
        )

    @app.post("/api/settings/api-key/rotate")
    async def rotate_key(token: str = Depends(browser_session)):
        key = store.issue_key(token, rotate=True)
        return JSONResponse({"api_key": key}, headers={"Cache-Control": "no-store"})

    @app.put("/api/settings/upstream")
    async def save_upstream(payload: KeyInput, token: str = Depends(browser_session)):
        store.save_upstream(token, payload.api_key.get_secret_value())
        return JSONResponse(
            store.public_settings(settings.opencode_api_key), headers={"Cache-Control": "no-store"}
        )

    @app.get("/v1/models", dependencies=[Depends(authorize)])
    async def models(free_only: bool = False):
        async with bridge.open(
            {"action": "models"}, upstream_api_key=store.upstream_key(settings.opencode_api_key)
        ) as response:
            if response.status >= 400:
                return await upstream_error(response)
            catalog = decode_json(await response.read())
            if not isinstance(catalog.get("data"), list):
                raise RelayError("上游模型列表缺少 data 数组。", code="invalid_upstream_response")
            data = [
                {**model, "object": "model", "is_free": is_free_model(model)}
                for model in catalog["data"]
                if isinstance(model, dict)
                and model.get("id")
                and is_chat_model(model)
                and (not free_only or is_free_model(model))
            ]
            return {"object": "list", "data": data}

    def conversation_seed(request: Request, body: dict[str, Any]) -> str | None:
        # One-shot probes should get a fresh session; agent/tool loops must keep one.
        messages = body.get("messages") if isinstance(body.get("messages"), list) else []
        has_tools = isinstance(body.get("tools"), list) and bool(body["tools"])
        # A probe with no tools is one-shot even if the client attaches a session
        # header. Tool-bearing requests are the ones that need session continuity.
        if not has_tools:
            return None
        for message in messages:
            if isinstance(message, dict) and message.get("role") == "user":
                return "user:" + json.dumps(
                    message.get("content"), ensure_ascii=False, sort_keys=True
                )
        for name in (
            "x-opencode-session",
            "x-opencode-session-id",
            "x-session-id",
            "x-session-affinity",
            "x-conversation-id",
            "conversation-id",
        ):
            value = (request.headers.get(name) or "").strip()
            if value:
                return f"header:{value}"
        for name in ("conversation_id", "session_id", "thread_id"):
            value = body.get(name)
            if isinstance(value, str) and value.strip():
                return f"body:{value.strip()}"
        return "model:" + str(body.get("model", ""))

    @app.post("/v1/chat/completions", dependencies=[Depends(authorize)])
    async def chat(payload: ChatRequest, request: Request):
        upstream_request = payload.model_dump(exclude_none=True)
        credential_fields = {"api_key", "apikey", "opencode_api_key", "authorization"}
        for name in tuple(upstream_request):
            if name.lower() in credential_fields:
                upstream_request.pop(name)
        seed = conversation_seed(request, upstream_request)

        async def open_upstream(identity_seed: str | None):
            context = bridge.open(
                {
                    "action": "chat",
                    "request": upstream_request,
                },
                upstream_api_key=store.upstream_key(settings.opencode_api_key),
                identity_seed=identity_seed,
            )
            return context, await context.__aenter__()

        context, response = await open_upstream(seed)
        # A free-lane 429 is often scoped to the synthetic session. Retry once
        # with a fresh identity so agent loops can continue after a stale session.
        if response.status == 429:
            await context.__aexit__(None, None, None)
            retry_seed = f"{seed or 'fresh'}:retry:{secrets.token_hex(8)}"
            context, response = await open_upstream(retry_seed)
        if not payload.stream or response.status >= 400:
            try:
                if response.status >= 400:
                    return await upstream_error(response)
                return JSONResponse(decode_json(await response.read()), headers=response.headers)
            finally:
                await context.__aexit__(None, None, None)

        async def stream():
            try:
                async for chunk in response.chunks():
                    yield chunk
            except RelayError as exc:
                event = json.dumps(error_body(exc.message, exc.code), ensure_ascii=False)
                yield f"data: {event}\n\ndata: [DONE]\n\n".encode()

        return ManagedStreamingResponse(
            stream(),
            context=context,
            headers={**response.headers, "Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    dist = ROOT / "frontend" / "dist"
    if dist.is_dir():
        app.mount("/assets", StaticFiles(directory=dist / "assets"), name="assets")

        @app.get("/", include_in_schema=False)
        async def index():
            return FileResponse(dist / "index.html")
    else:

        @app.get("/", include_in_schema=False)
        async def dev_index():
            return {
                "name": "OpenCode Relay",
                "frontend": "http://127.0.0.1:8948",
                "docs": "/docs",
                "hint": "bun run dev 或先 bun run build 再 bun run start",
            }

    return app


app = create_app()
