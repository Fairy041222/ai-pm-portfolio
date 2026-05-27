from contextlib import asynccontextmanager
import logging

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.config import get_settings
from app.database import AsyncSessionLocal, init_db
from app.exception_handlers import (
    http_exception_handler,
    request_validation_handler,
    unhandled_exception_handler,
)
from app.routers import conversations, evaluation, llm_proxy, messages, models_router, reports, security
from app.schemas import HealthResponse
from app.seed import seed_database

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await init_db()
    async with AsyncSessionLocal() as session:
        await seed_database(session)
        await session.commit()
    yield


app = FastAPI(
    title="AIPM Bench API",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_exception_handler(RequestValidationError, request_validation_handler)
app.add_exception_handler(StarletteHTTPException, http_exception_handler)
app.add_exception_handler(Exception, unhandled_exception_handler)

settings = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(conversations.router)
app.include_router(messages.router)
app.include_router(evaluation.router)
app.include_router(reports.router)
app.include_router(models_router.router)
app.include_router(security.router)
app.include_router(llm_proxy.router)


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(status="ok", database="connected")


@app.get("/api/health", response_model=HealthResponse)
async def api_health() -> HealthResponse:
    return HealthResponse(status="ok", database="connected")
