import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.schemas import SecurityCheckQuotaResponse
from app.services.security_service import DAILY_EVAL_LIMIT, security_store

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/security", tags=["security"])


class SecurityCheckQuotaRequest(BaseModel):
    session_id: str = Field(min_length=1, max_length=128)
    action: str = Field(default="check", description="check=仅检查并记录日志; consume=检查并消耗一次配额")

    model_config = {"populate_by_name": True}


@router.post("/check-quota", response_model=SecurityCheckQuotaResponse)
async def check_security_quota(body: SecurityCheckQuotaRequest) -> SecurityCheckQuotaResponse:
    """
    前端发起评测前调用，便于在后端控制台输出 [SECURITY] 日志。
    action=check 不消耗配额；action=consume 在通过检查时消耗一次（一般由 /messages 评测入口消耗）。
    """
    action = (body.action or "check").strip().lower()
    if action not in ("check", "consume"):
        raise HTTPException(status_code=400, detail="action 必须为 check 或 consume")

    security_store.log_eval_request_received(body.session_id, source="check-quota")

    if action == "consume":
        dup = security_store.check_duplicate_click(body.session_id)
        if not dup.allowed:
            return SecurityCheckQuotaResponse(
                allowed=False,
                current_count=security_store.get_daily_count(body.session_id),
                daily_limit=DAILY_EVAL_LIMIT,
                remaining=max(
                    0,
                    DAILY_EVAL_LIMIT - security_store.get_daily_count(body.session_id),
                ),
                duplicate_blocked=True,
                message=dup.message,
            )

    result = security_store.check_quota(
        body.session_id,
        consume=(action == "consume"),
        source="check-quota",
    )
    return SecurityCheckQuotaResponse(
        allowed=result.allowed,
        current_count=result.current_count,
        daily_limit=result.daily_limit,
        remaining=result.remaining,
        duplicate_blocked=False,
        message=result.message,
    )
