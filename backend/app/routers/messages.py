import logging
from datetime import datetime

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import ConversationORM, MessageORM
from app.schemas import (
    ClientModelMetaSchema,
    ClientTextPendingResponse,
    ReportPendingResponse,
    SaveAssistantMessageRequest,
    SendMessageRequest,
    TextMessageResponse,
)
from app.services.conversation_service import get_conversation, message_to_schema
from app.services.endpoint_inference import infer_vendor_from_text
from app.services.evaluation_progress import progress_store
from app.services.evaluation_runner import run_evaluation_background
from app.services.eval_timing import estimate_eval_duration_seconds
from app.services.model_resolver import resolve_model_ids
from app.services.security_service import (
    DAILY_EVAL_LIMIT,
    log_api_key_policy_pass,
    security_store,
)
from app.services.test_case_generator import DEFAULT_TEST_CASE_COUNT, detect_scenario
from app.utils import format_time, is_report_trigger_content, new_id

logger = logging.getLogger(__name__)


def derive_title_from_content(content: str, fallback: str = "新对话") -> str:
    text = content.strip()
    if not text or is_report_trigger_content(text):
        return fallback
    return text[:16] + "..." if len(text) > 16 else text


def resolve_evaluation_question(body: SendMessageRequest, conv: ConversationORM) -> str:
    question = body.resolved_question()
    if question and not is_report_trigger_content(question):
        return question

    for msg in reversed(conv.messages):
        if msg.role == "user" and msg.content.strip():
            prev = msg.content.strip()
            if not is_report_trigger_content(prev):
                return prev

    return question or body.resolved_question()


router = APIRouter(prefix="/api/conversations", tags=["messages"])


@router.post(
    "/{conversation_id}/messages",
    response_model=ClientTextPendingResponse | ReportPendingResponse,
)
async def send_message(
    conversation_id: str,
    body: SendMessageRequest,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
) -> ClientTextPendingResponse | ReportPendingResponse:
    conv = await get_conversation(db, conversation_id)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")

    user_question = resolve_evaluation_question(body, conv)
    raw_model_ids = body.model_ids or []
    logger.info(
        "send_message conversation=%s question=%s model_ids=%s",
        conversation_id,
        user_question,
        raw_model_ids,
    )

    if not user_question and not body.resolved_question():
        raise HTTPException(status_code=400, detail="content 或 question 不能为空")

    now = datetime.utcnow()
    message_text = body.resolved_question() or user_question
    user_msg = MessageORM(
        id=new_id("msg_"),
        conversation_id=conversation_id,
        role="user",
        content=message_text,
        type="text",
        timestamp=format_time(now),
        created_at=now,
    )
    db.add(user_msg)

    if len(conv.messages) == 0 or conv.title == "新对话":
        conv.title = derive_title_from_content(message_text, conv.title)
    conv.updated_at = now

    is_report_trigger = is_report_trigger_content(message_text)
    is_report_mode = is_report_trigger or len(body.model_ids or []) >= 2

    resolved_ids, model_records, used_default_model, primary_model_name = await resolve_model_ids(
        db,
        body.model_ids,
        is_report_mode=is_report_mode,
    )
    model_ids = resolved_ids

    if is_report_mode:
        if len(model_records) < 2:
            raise HTTPException(
                status_code=400,
                detail="生成报告需要至少 2 个已配置的模型，请先添加并勾选模型",
            )

        session_id = (body.session_id or "anonymous").strip() or "anonymous"
        security_store.log_eval_request_received(session_id, source="messages")

        log_api_key_policy_pass(context="send_message_report", session_id=session_id)

        dup = security_store.check_duplicate_click(session_id)
        if not dup.allowed:
            raise HTTPException(status_code=429, detail=dup.message or "操作过于频繁，请稍后再试")

        quota = security_store.check_quota(session_id, consume=True, source="messages")
        if not quota.allowed:
            raise HTTPException(
                status_code=429,
                detail=quota.message or f"今日评测次数已达上限（{DAILY_EVAL_LIMIT}/{DAILY_EVAL_LIMIT}）",
            )

        task_id = new_id("eval_")
        eta_total = estimate_eval_duration_seconds(
            len(model_records),
            DEFAULT_TEST_CASE_COUNT,
        )
        progress_store.create(
            task_id,
            conversation_id,
            estimated_total_seconds=eta_total,
            model_count=len(model_records),
            user_question=user_question,
            scenario=detect_scenario(user_question),
            model_ids=model_ids,
        )
        progress_store.update(
            task_id,
            progress=5,
            current_step="生成用例",
            completed_cases=0,
            total_cases=DEFAULT_TEST_CASE_COUNT,
            estimated_total_seconds=eta_total,
            model_count=len(model_records),
        )

        await db.flush()
        msg_schema = message_to_schema(user_msg)

        background_tasks.add_task(
            run_evaluation_background,
            task_id=task_id,
            conversation_id=conversation_id,
            user_question=user_question,
            model_ids=model_ids,
        )

        return ReportPendingResponse(task_id=task_id, message=msg_schema)

    if not model_records:
        raise HTTPException(
            status_code=400,
            detail="暂无可用模型，请先在右侧「添加模型」中配置 API 地址",
        )

    first = model_records[0]
    session_id = (body.session_id or "anonymous").strip() or "anonymous"
    log_api_key_policy_pass(context="send_message_chat", session_id=session_id)
    await db.flush()
    msg_schema = message_to_schema(user_msg)

    return ClientTextPendingResponse(
        message=msg_schema,
        model=ClientModelMetaSchema(
            id=first.id,
            name=first.name,
            api_endpoint=first.api_endpoint or "",
            api_model=first.model_identifier or "",
            vendor=infer_vendor_from_text(first.api_endpoint or "", first.name or ""),
        ),
        used_default_model=used_default_model,
    )


@router.post(
    "/{conversation_id}/messages/assistant",
    response_model=TextMessageResponse,
)
async def save_assistant_message(
    conversation_id: str,
    body: SaveAssistantMessageRequest,
    db: AsyncSession = Depends(get_db),
) -> TextMessageResponse:
    """保存浏览器直连模型后的助手回复（不经过服务端 LLM）。"""
    conv = await get_conversation(db, conversation_id)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")

    content = body.content.strip()
    if not content:
        raise HTTPException(status_code=400, detail="content 不能为空")

    now = datetime.utcnow()
    assistant_msg = MessageORM(
        id=new_id("msg_"),
        conversation_id=conversation_id,
        role="assistant",
        content=content,
        type="text",
        timestamp=format_time(now),
        metadata_json={
            "used_model_name": body.used_model_name,
            "used_default_model": body.used_default_model,
        }
        if body.used_model_name
        else None,
        created_at=now,
    )
    db.add(assistant_msg)
    conv.updated_at = now
    await db.flush()

    msg_schema = message_to_schema(assistant_msg)
    return TextMessageResponse(
        content=content,
        message=msg_schema,
        used_model_name=body.used_model_name,
        used_default_model=body.used_default_model,
    )


@router.post("/{conversation_id}/messages/upload", status_code=501)
async def upload_message_file(conversation_id: str) -> None:
    raise HTTPException(
        status_code=501,
        detail="File upload is not implemented in MVP.",
    )
