"""全局异常处理：记录堆栈并返回结构化 JSON 错误。"""

from __future__ import annotations

import logging
import traceback

from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

logger = logging.getLogger(__name__)


def _format_validation_errors(exc: RequestValidationError) -> str:
    parts: list[str] = []
    for err in exc.errors():
        loc = ".".join(str(x) for x in err.get("loc", ()))
        msg = err.get("msg", "参数错误")
        parts.append(f"{loc}: {msg}" if loc else str(msg))
    return "; ".join(parts) if parts else "请求参数验证失败"


async def request_validation_handler(
    request: Request,
    exc: RequestValidationError,
) -> JSONResponse:
    detail = _format_validation_errors(exc)
    logger.warning(
        "请求参数验证失败 %s %s | %s",
        request.method,
        request.url.path,
        detail,
    )
    return JSONResponse(status_code=422, content={"detail": detail, "errors": exc.errors()})


async def http_exception_handler(
    request: Request,
    exc: StarletteHTTPException,
) -> JSONResponse:
    detail = exc.detail if isinstance(exc.detail, str) else str(exc.detail)
    if exc.status_code >= 500:
        logger.error(
            "HTTP %s %s %s | %s",
            exc.status_code,
            request.method,
            request.url.path,
            detail,
        )
    return JSONResponse(status_code=exc.status_code, content={"detail": detail})


async def unhandled_exception_handler(
    request: Request,
    exc: Exception,
) -> JSONResponse:
    tb = traceback.format_exc()
    logger.error(
        "未捕获异常 %s %s | %s\n%s",
        request.method,
        request.url.path,
        exc,
        tb,
    )
    message = f"{type(exc).__name__}: {exc}"
    return JSONResponse(
        status_code=500,
        content={
            "detail": f"服务器内部错误：{message}",
            "error_type": type(exc).__name__,
        },
    )
