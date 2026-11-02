"""Cancel upstream work even if the browser disconnects before response headers arrive."""

import asyncio

from starlette.types import ASGIApp, Receive, Scope, Send


class CancelOnDisconnectMiddleware:
    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not scope["path"].startswith("/v1/"):
            await self.app(scope, receive, send)
            return

        messages = asyncio.Queue(maxsize=1)
        disconnected = False
        request_task = asyncio.create_task(self.app(scope, messages.get, send))

        async def watch_connection():
            nonlocal disconnected
            while True:
                message = await receive()
                if message["type"] == "http.disconnect":
                    disconnected = True
                    request_task.cancel()
                    return
                await messages.put(message)

        watcher = asyncio.create_task(watch_connection())
        try:
            await request_task
        except asyncio.CancelledError:
            if not disconnected:
                raise
        finally:
            watcher.cancel()
            await asyncio.gather(watcher, return_exceptions=True)
