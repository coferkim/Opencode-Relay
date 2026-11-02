import hmac
import json
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from typing import Annotated, Any, Literal

from fastapi import Depends, FastAPI, Header, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field
from starlette.types import Receive, Scope, Send

from .bridge import BunBridge, RelayError
from .config import ROOT, Settings
from .disconnect import CancelOnDisconnectMiddleware


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

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        yield
        await bridge.close()

    app = FastAPI(title="OpenCode Relay", version="0.1.0", lifespan=lifespan)
    app.add_middleware(CancelOnDisconnectMiddleware)
    app.state.bridge = bridge

    async def authorize(authorization: Annotated[str | None, Header()] = None) -> None:
        if settings.relay_api_key:
            supplied = authorization or ""
            expected = f"Bearer {settings.relay_api_key}"
            if not hmac.compare_digest(supplied.encode(), expected.encode()):
                raise RelayError("Relay API Key 无效。", 401, "invalid_api_key")

    async def upstream_key(
        key: Annotated[str | None, Header(alias="X-OpenCode-API-Key", max_length=4096)] = None,
    ) -> str | None:
        key = (key or "").strip()
        if any(not 33 <= ord(char) <= 126 for char in key):
            raise RelayError("上游 API Key 包含无效字符。", 400, "invalid_api_key")
        return key or None

    @app.exception_handler(RelayError)
    async def handle_relay_error(request: Request, exc: RelayError):
        return JSONResponse(error_body(exc.message, exc.code), status_code=exc.status)

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
        return JSONResponse(data, status_code=response.status, headers=response.headers)

    @app.get("/api/health")
    async def health():
        return {
            "status": "ok",
            "transport": "bun-native",
            "auth_required": bool(settings.relay_api_key),
        }

    @app.get("/v1/models", dependencies=[Depends(authorize)])
    async def models(free_only: bool = False, api_key: str | None = Depends(upstream_key)):
        async with bridge.open({"action": "models"}, upstream_api_key=api_key) as response:
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

    @app.post("/v1/chat/completions", dependencies=[Depends(authorize)])
    async def chat(payload: ChatRequest, api_key: str | None = Depends(upstream_key)):
        context = bridge.open(
            {
                "action": "chat",
                "request": payload.model_dump(exclude_none=True),
            },
            upstream_api_key=api_key,
        )
        # Read upstream status before committing the HTTP headers of an SSE response.
        response = await context.__aenter__()
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
