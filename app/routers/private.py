"""Shared HTTP boundary for owner-scoped Reader APIs."""

import psycopg
from fastapi import HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from psycopg_pool import PoolClosed, PoolTimeout

from app.db.pool import get_pool

MAX_BODY_BYTES = 2048


class PrivateReaderRoute(APIRoute):
    unavailable_code: str

    def get_route_handler(self):
        handle = super().get_route_handler()

        async def private_handler(request: Request) -> Response:
            size = 0

            async def receive():
                nonlocal size
                message = await request.receive()
                size += len(message.get("body", b""))
                if size > MAX_BODY_BYTES:
                    raise HTTPException(413, detail={"code": "payload_too_large"})
                return message

            try:
                length = request.headers.get("content-length")
                if request.method in {"POST", "PUT", "DELETE"} and length is not None:
                    if not length.isascii() or not length.isdecimal() or len(length) > 19:
                        raise HTTPException(400, detail={"code": "invalid_content_length"})
                    if int(length) > MAX_BODY_BYTES:
                        raise HTTPException(413, detail={"code": "payload_too_large"})
                response = await handle(Request(request.scope, receive))
            except RequestValidationError:
                # Validation responses may otherwise echo invalid body/header values.
                response = JSONResponse({"detail": {"code": "invalid_request"}}, status_code=422)
            except HTTPException as exc:
                response = JSONResponse(
                    {"detail": exc.detail}, status_code=exc.status_code, headers=exc.headers
                )
            except (psycopg.Error, PoolClosed, PoolTimeout):
                response = self._unavailable()
            except RuntimeError:
                # The session dependency can reach the pool before the service does.
                try:
                    get_pool()
                except RuntimeError:
                    response = self._unavailable()
                else:
                    raise
            response.headers["Cache-Control"] = "no-store"
            return response

        return private_handler

    def _unavailable(self) -> JSONResponse:
        return JSONResponse({"detail": {"code": self.unavailable_code}}, status_code=503)
