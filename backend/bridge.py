"""FastAPI owns one isolated Bun process per upstream request, including cancellation."""

import asyncio
import json
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass

from .config import ROOT, Settings

MAX_BODY_BYTES = 16 * 1024 * 1024
FORWARDED_HEADERS = {"retry-after", "x-request-id", "x-opencode-log-id", "x-zen-model"}


class RelayError(Exception):
    def __init__(self, message: str, status: int = 502, code: str = "upstream_error"):
        self.message = message
        self.status = status
        self.code = code
        super().__init__(message)


@dataclass
class BunResponse:
    process: asyncio.subprocess.Process
    status: int
    headers: dict[str, str]
    deadline: float

    async def chunks(self) -> AsyncIterator[bytes]:
        assert self.process.stdout is not None
        try:
            while chunk := await asyncio.wait_for(
                self.process.stdout.read(65536),
                timeout=max(0.001, self.deadline - asyncio.get_running_loop().time()),
            ):
                yield chunk
        except TimeoutError as exc:
            raise RelayError("上游响应超时。", 504, "upstream_timeout") from exc
        if await self.process.wait() != 0:
            raise RelayError("Bun 子进程在响应完成前退出。", code="bridge_exit")

    async def read(self) -> bytes:
        body = bytearray()
        async for chunk in self.chunks():
            body.extend(chunk)
            if len(body) > MAX_BODY_BYTES:
                raise RelayError("上游响应超过 16 MiB 限制。", code="response_too_large")
        return bytes(body)


async def drain_stderr(stream: asyncio.StreamReader) -> None:
    # Drain without logging request content or credentials, and without an unbounded buffer.
    while await stream.read(8192):
        pass


class BunBridge:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.slots = asyncio.Semaphore(settings.opencode_max_concurrent_requests)
        self.processes: set[asyncio.subprocess.Process] = set()

    @asynccontextmanager
    async def open(
        self,
        payload: dict,
        *,
        upstream_api_key: str | None = None,
        identity_seed: str | None = None,
    ) -> AsyncIterator[BunResponse]:
        process = None
        stderr_task = None
        try:
            async with self.slots:
                env = {
                    **os.environ,
                    "OPENCODE_API_KEY": upstream_api_key
                    or self.settings.opencode_api_key
                    or "public",
                    "OPENCODE_BASE_URL": self.settings.opencode_base_url,
                    "OPENCODE_CLIENT": self.settings.opencode_client,
                    "OPENCODE_VERSION": self.settings.opencode_version,
                    "OPENCODE_TIMEOUT_MS": str(int(self.settings.opencode_timeout_seconds * 1000)),
                }
                if self.settings.opencode_models_url:
                    env["OPENCODE_MODELS_URL"] = self.settings.opencode_models_url
                process = await asyncio.create_subprocess_exec(
                    self.settings.bun_executable,
                    "run",
                    str(ROOT / "bridge" / "worker.ts"),
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    cwd=ROOT,
                    env=env,
                    limit=1024 * 1024,
                )
                self.processes.add(process)
                assert process.stdin and process.stdout and process.stderr
                stderr_task = asyncio.create_task(drain_stderr(process.stderr))
                worker_payload = dict(payload)
                if identity_seed:
                    worker_payload["identitySeed"] = identity_seed
                process.stdin.write(json.dumps(worker_payload, ensure_ascii=False).encode("utf-8"))
                await process.stdin.drain()
                process.stdin.close()
                deadline = (
                    asyncio.get_running_loop().time() + self.settings.opencode_timeout_seconds + 5
                )
                first_line = await asyncio.wait_for(
                    process.stdout.readline(), timeout=self.settings.opencode_timeout_seconds + 5
                )
                if not first_line:
                    raise RelayError(
                        "Bun 未返回响应头，请检查 Bun 版本及服务配置。", code="bridge_exit"
                    )
                try:
                    metadata = json.loads(first_line)
                    status = int(metadata["status"])
                    if not 100 <= status <= 599:
                        raise ValueError("Invalid HTTP status")
                except (ValueError, KeyError, TypeError) as exc:
                    raise RelayError("Bun 返回了无效的响应头。", code="bridge_protocol") from exc
                headers = {
                    name: value
                    for name, value in metadata.get("headers", {}).items()
                    if name.lower() in FORWARDED_HEADERS and isinstance(value, str)
                }
                yield BunResponse(process, status, headers, deadline)
        except FileNotFoundError as exc:
            raise RelayError(
                "找不到 Bun，请安装 Bun 或设置 BUN_EXECUTABLE。", 503, "bun_missing"
            ) from exc
        except TimeoutError as exc:
            raise RelayError("上游请求超时。", 504, "upstream_timeout") from exc
        finally:
            if process is not None:
                if process.returncode is None:
                    try:
                        process.kill()
                    except ProcessLookupError:
                        pass
                cleanup = [process.wait()]
                if process.stdout is not None:
                    cleanup.append(drain_stderr(process.stdout))
                if stderr_task is not None:
                    cleanup.append(stderr_task)
                if process.stdin is not None:
                    cleanup.append(process.stdin.wait_closed())
                # Drain pipes after termination so Windows Proactor transports are released.
                cleanup_future = asyncio.gather(*cleanup, return_exceptions=True)
                try:
                    await asyncio.shield(cleanup_future)
                except asyncio.CancelledError:
                    await cleanup_future
                self.processes.discard(process)

    async def close(self) -> None:
        for process in list(self.processes):
            if process.returncode is None:
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
        await asyncio.gather(*(process.wait() for process in list(self.processes)))
