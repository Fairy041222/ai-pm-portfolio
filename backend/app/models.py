from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, Text, Boolean, JSON
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class AppMetaORM(Base):
    """应用元数据（如是否已写入首次默认模型）。"""

    __tablename__ = "app_meta"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[str] = mapped_column(String(256), default="")


class ConversationORM(Base):
    __tablename__ = "conversations"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    title: Mapped[str] = mapped_column(String(256), default="新对话")
    recommended_model: Mapped[str] = mapped_column(String(128), default="")
    related_report_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )

    messages: Mapped[list["MessageORM"]] = relationship(
        back_populates="conversation",
        cascade="all, delete-orphan",
        order_by="MessageORM.created_at",
    )
    reports: Mapped[list["ReportORM"]] = relationship(
        back_populates="conversation",
        cascade="all, delete-orphan",
    )


class MessageORM(Base):
    __tablename__ = "messages"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    conversation_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("conversations.id", ondelete="CASCADE")
    )
    role: Mapped[str] = mapped_column(String(16))
    content: Mapped[str] = mapped_column(Text, default="")
    type: Mapped[str] = mapped_column(String(16), default="text")
    timestamp: Mapped[str] = mapped_column(String(32), default="")
    metadata_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    conversation: Mapped["ConversationORM"] = relationship(back_populates="messages")


class ModelORM(Base):
    __tablename__ = "models"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(128))
    provider_type: Mapped[str] = mapped_column(String(32), default="openai_compatible")
    api_endpoint: Mapped[str] = mapped_column(String(512), default="")
    model_identifier: Mapped[str] = mapped_column(String(128), default="")
    api_key_encrypted: Mapped[str | None] = mapped_column(Text, nullable=True)
    custom_request_template: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_recommended: Mapped[bool] = mapped_column(Boolean, default=False)
    # 遗留列，不再使用
    provider: Mapped[str] = mapped_column(String(64), default="openai_compatible")
    is_custom: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class ReportORM(Base):
    __tablename__ = "reports"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    conversation_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("conversations.id", ondelete="CASCADE")
    )
    report_data: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    conversation: Mapped["ConversationORM"] = relationship(back_populates="reports")
