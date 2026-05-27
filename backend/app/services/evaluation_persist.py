"""评测报告持久化（与内存进度解耦，可单独重试）。"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError, OperationalError

from app.database import AsyncSessionLocal
from app.models import MessageORM, ReportORM
from app.schemas import MessageSchema, ReportDataSchema
from app.services.conversation_service import get_conversation, message_to_schema
from app.services.evaluation_progress import progress_store
from app.services.report_service import build_report_intro_text
from app.utils import format_time, new_id

logger = logging.getLogger(__name__)

_COMMIT_MAX_RETRIES = 8
_COMMIT_RETRY_BASE_SECONDS = 0.1


async def persist_report_from_task(task_id: str) -> dict:
    """将 progress_store 中已完成的报告写入数据库（可重复调用）。"""
    state = progress_store.get(task_id)
    if not state:
        raise ValueError("评测任务不存在或已过期")
    if state.status != "completed" or not state.report_data:
        raise ValueError("任务尚未生成报告，无法保存")

    conversation_id = state.conversation_id
    report_payload = state.report_data
    user_question = state.user_question or ""
    scenario = state.scenario or "generic"
    report = ReportDataSchema.model_validate(report_payload)
    intro_text = build_report_intro_text(user_question, scenario, report)

    last_error: Exception | None = None
    for attempt in range(_COMMIT_MAX_RETRIES):
        try:
            now = datetime.utcnow()
            async with AsyncSessionLocal() as db:
                conv = await get_conversation(db, conversation_id)
                if not conv:
                    raise ValueError("对话不存在")

                existing = await db.execute(
                    select(ReportORM).where(ReportORM.id == report.id)
                )
                if existing.scalar_one_or_none():
                    progress_store.mark_persist_saved(task_id)
                    return {
                        "ok": True,
                        "report_id": report.id,
                        "conversation_id": conversation_id,
                        "already_saved": True,
                    }

                db.add(
                    ReportORM(
                        id=report.id,
                        conversation_id=conversation_id,
                        report_data=report_payload,
                        created_at=now,
                    )
                )
                assistant_msg = MessageORM(
                    id=new_id("msg_"),
                    conversation_id=conversation_id,
                    role="assistant",
                    content=intro_text,
                    type="report",
                    timestamp=format_time(now),
                    metadata_json=report_payload,
                    created_at=now,
                )
                db.add(assistant_msg)
                conv.related_report_id = report.id
                conv.updated_at = now
                await db.commit()

                msg_schema = message_to_schema(assistant_msg)
                progress_store.complete(
                    task_id,
                    report_data=report_payload,
                    message=msg_schema.model_dump(by_alias=True),
                    persist_status="saved",
                )
                logger.info(
                    "报告已持久化 task_id=%s report_id=%s conv=%s",
                    task_id,
                    report.id,
                    conversation_id,
                )
                return {
                    "ok": True,
                    "report_id": report.id,
                    "conversation_id": conversation_id,
                    "already_saved": False,
                }
        except (OperationalError, IntegrityError) as exc:
            last_error = exc
            err_text = str(exc).lower()
            retryable = "locked" in err_text or "unique" in err_text
            if not retryable or attempt >= _COMMIT_MAX_RETRIES - 1:
                break
            delay = _COMMIT_RETRY_BASE_SECONDS * (2**attempt)
            logger.warning("报告持久化重试 %s/%s: %s", attempt + 1, _COMMIT_MAX_RETRIES, exc)
            await asyncio.sleep(delay)
        except Exception as exc:
            last_error = exc
            break

    error_msg = str(last_error) if last_error else "未知错误"
    progress_store.mark_persist_failed(task_id, error_msg)
    raise RuntimeError(f"报告保存失败：{error_msg}") from last_error


def schedule_persist_report(task_id: str) -> None:
    """后台异步落库，不阻塞 complete 返回给前端。"""

    async def _run() -> None:
        try:
            await persist_report_from_task(task_id)
        except Exception as exc:
            logger.error("后台报告持久化失败 task_id=%s: %s", task_id, exc)

    asyncio.create_task(_run())
