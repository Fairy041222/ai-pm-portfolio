import json

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import ReportORM
from app.schemas import ExportReportRequest, ExportReportResponse, ReportDataSchema
from app.services.report_service import report_to_markdown

router = APIRouter(prefix="/api/reports", tags=["reports"])


@router.get("/{conversation_id}", response_model=ReportDataSchema)
async def get_report_by_conversation(
    conversation_id: str,
    db: AsyncSession = Depends(get_db),
) -> ReportDataSchema:
    result = await db.execute(
        select(ReportORM)
        .where(ReportORM.conversation_id == conversation_id)
        .order_by(ReportORM.created_at.desc())
    )
    report = result.scalars().first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    return ReportDataSchema.model_validate(report.report_data)


@router.post("/{report_id}/export", response_model=ExportReportResponse)
async def export_report(
    report_id: str,
    body: ExportReportRequest,
    db: AsyncSession = Depends(get_db),
) -> ExportReportResponse:
    result = await db.execute(select(ReportORM).where(ReportORM.id == report_id))
    report = result.scalar_one_or_none()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")

    data = ReportDataSchema.model_validate(report.report_data)

    if body.format == "json":
        content = json.dumps(data.model_dump(by_alias=True), ensure_ascii=False, indent=2)
        return ExportReportResponse(
            filename="大模型评测数据.json",
            content=content,
            content_type="application/json",
        )

    content = report_to_markdown(data)
    return ExportReportResponse(
        filename="大模型性能对比报告.md",
        content=content,
        content_type="text/markdown",
    )
