from datetime import datetime

from sqlalchemy.ext.asyncio import AsyncSession

from app.models import AppMetaORM, ConversationORM, MessageORM, ReportORM
from app.services.report_service import generate_mock_report

PRD_CONVERSATION_ID = "prd-organize"
PRD_REPORT_ID = "report-prd-organize"
MSG_PRD_USER_ID = "msg-prd-user-1"
MSG_PRD_ASSISTANT_ID = "msg-prd-assistant-1"

DEFAULT_MODELS_META_KEY = "default_models_seeded"


async def _seed_default_models(db: AsyncSession) -> None:
    """不再自动写入默认模型；用户在前端「添加模型」中自行配置。"""
    meta = await db.get(AppMetaORM, DEFAULT_MODELS_META_KEY)
    if meta and meta.value == "1":
        return

    await db.merge(AppMetaORM(key=DEFAULT_MODELS_META_KEY, value="1"))
    print("[seed] 模型表保持空白，请在右侧「添加模型」中配置 API")


async def seed_database(db: AsyncSession) -> None:
    """幂等种子数据：可重复执行，不会因主键冲突报错。"""
    await _seed_default_models(db)

    now = datetime.utcnow()
    prd_id = PRD_CONVERSATION_ID
    report = generate_mock_report(prd_id)
    report_data = report.model_dump(by_alias=True)
    report_data["id"] = PRD_REPORT_ID
    report_data["conversationId"] = prd_id

    assistant_content = (
        "好的，我已分析需求文档。核心功能点包括：1. 用户权限管理（角色分级、权限配置）；"
        "2. 数据看板（实时统计、图表展示）；3. 审批流程（多级审批、消息通知）；"
        "4. 报表导出（支持 Excel/PDF 格式）。是否需要我生成详细的模型对比报告？"
    )

    await db.merge(
        ConversationORM(
            id=prd_id,
            title="产品需求整理",
            recommended_model="",
            related_report_id=PRD_REPORT_ID,
            created_at=now,
            updated_at=now,
        )
    )

    await db.merge(
        ReportORM(
            id=PRD_REPORT_ID,
            conversation_id=prd_id,
            report_data=report_data,
            created_at=now,
        )
    )

    await db.merge(
        MessageORM(
            id=MSG_PRD_USER_ID,
            conversation_id=prd_id,
            role="user",
            content="请帮我整理这份产品需求文档，提取核心功能点",
            type="text",
            timestamp="2026-05-16 09:20",
            metadata_json=None,
            created_at=now,
        )
    )

    await db.merge(
        MessageORM(
            id=MSG_PRD_ASSISTANT_ID,
            conversation_id=prd_id,
            role="assistant",
            content=assistant_content,
            type="report",
            timestamp="2026-05-16 09:22",
            metadata_json=report_data,
            created_at=now,
        )
    )

    await db.flush()
