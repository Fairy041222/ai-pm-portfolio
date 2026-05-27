from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import ConversationORM
from app.schemas import ConversationSchema, DeleteConversationsRequest
from app.services.conversation_service import conversation_to_schema, get_all_conversations
from app.utils import format_datetime, new_id

router = APIRouter(prefix="/api/conversations", tags=["conversations"])


@router.get("", response_model=list[ConversationSchema])
async def list_conversations(db: AsyncSession = Depends(get_db)) -> list[ConversationSchema]:
    return await get_all_conversations(db)


@router.post("", response_model=ConversationSchema, status_code=201)
async def create_conversation(db: AsyncSession = Depends(get_db)) -> ConversationSchema:
    now = datetime.utcnow()
    conv = ConversationORM(
        id=new_id("conv_"),
        title="新对话",
        recommended_model="",
        created_at=now,
        updated_at=now,
    )
    db.add(conv)
    await db.flush()
    await db.refresh(conv, attribute_names=["messages"])
    return conversation_to_schema(conv)


@router.delete("", status_code=204)
async def delete_conversations(
    body: DeleteConversationsRequest,
    db: AsyncSession = Depends(get_db),
) -> None:
    if not body.ids:
        return
    await db.execute(delete(ConversationORM).where(ConversationORM.id.in_(body.ids)))


@router.get("/{conversation_id}", response_model=ConversationSchema)
async def get_conversation_detail(
    conversation_id: str,
    db: AsyncSession = Depends(get_db),
) -> ConversationSchema:
    from sqlalchemy.orm import selectinload

    result = await db.execute(
        select(ConversationORM)
        .where(ConversationORM.id == conversation_id)
        .options(selectinload(ConversationORM.messages))
    )
    conv = result.scalar_one_or_none()
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return conversation_to_schema(conv)
