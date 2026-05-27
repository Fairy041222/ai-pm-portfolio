from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models import ConversationORM, MessageORM
from app.schemas import ConversationSchema, MessageSchema, ReportDataSchema
from app.utils import format_datetime


def message_to_schema(msg: MessageORM) -> MessageSchema:
    report_data = None
    used_model_name = None
    used_default_model = None
    if msg.metadata_json:
        if msg.type == "report":
            report_data = ReportDataSchema.model_validate(msg.metadata_json)
        elif msg.role == "assistant":
            used_model_name = msg.metadata_json.get("used_model_name")
            used_default_model = msg.metadata_json.get("used_default_model")
    return MessageSchema(
        id=msg.id,
        role=msg.role,  # type: ignore[arg-type]
        content=msg.content,
        timestamp=msg.timestamp,
        type=msg.type,  # type: ignore[arg-type]
        report_data=report_data,
        used_model_name=used_model_name,
        used_default_model=used_default_model,
    )


def conversation_to_schema(conv: ConversationORM) -> ConversationSchema:
    return ConversationSchema(
        id=conv.id,
        title=conv.title,
        date=format_datetime(conv.updated_at or conv.created_at),
        recommended_model=conv.recommended_model or "",
        messages=[message_to_schema(m) for m in conv.messages],
        related_report_id=conv.related_report_id,
    )


async def get_all_conversations(db: AsyncSession) -> list[ConversationSchema]:
    result = await db.execute(
        select(ConversationORM)
        .options(selectinload(ConversationORM.messages))
        .order_by(ConversationORM.updated_at.desc())
    )
    convs = result.scalars().unique().all()
    return [conversation_to_schema(c) for c in convs]


async def get_conversation(db: AsyncSession, conversation_id: str) -> ConversationORM | None:
    result = await db.execute(
        select(ConversationORM)
        .where(ConversationORM.id == conversation_id)
        .options(selectinload(ConversationORM.messages))
    )
    return result.scalar_one_or_none()
