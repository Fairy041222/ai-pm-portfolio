"""NFR-P5 安全策略：每日限额、防重复点击、API Key 策略日志（内存计数，按 session_id）。"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass
from datetime import date

logger = logging.getLogger(__name__)

DAILY_EVAL_LIMIT = 20
EVAL_COOLDOWN_SECONDS = 10


@dataclass(frozen=True)
class QuotaCheckResult:
    allowed: bool
    current_count: int
    daily_limit: int
    remaining: int
    message: str | None = None


@dataclass(frozen=True)
class DuplicateClickResult:
    allowed: bool
    seconds_since_last: float | None = None
    message: str | None = None


class SecurityStore:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._daily_counts: dict[str, tuple[str, int]] = {}
        self._last_eval_at: dict[str, float] = {}

    def _today(self) -> str:
        return date.today().isoformat()

    def get_daily_count(self, session_id: str) -> int:
        sid = (session_id or "anonymous").strip() or "anonymous"
        today = self._today()
        with self._lock:
            rec = self._daily_counts.get(sid)
            if not rec or rec[0] != today:
                return 0
            return rec[1]

    def _increment_daily(self, session_id: str) -> int:
        sid = (session_id or "anonymous").strip() or "anonymous"
        today = self._today()
        with self._lock:
            rec = self._daily_counts.get(sid)
            if not rec or rec[0] != today:
                count = 1
            else:
                count = rec[1] + 1
            self._daily_counts[sid] = (today, count)
            return count

    def log_eval_request_received(self, session_id: str, *, source: str = "api") -> None:
        count = self.get_daily_count(session_id)
        logger.info(
            "[SECURITY] 收到评测请求 - session_id=%s - source=%s - 当前会话已评测次数=%d/%d",
            session_id,
            source,
            count,
            DAILY_EVAL_LIMIT,
        )

    def check_quota(
        self,
        session_id: str,
        *,
        consume: bool = False,
        source: str = "api",
    ) -> QuotaCheckResult:
        sid = (session_id or "anonymous").strip() or "anonymous"
        count = self.get_daily_count(sid)
        remaining = max(0, DAILY_EVAL_LIMIT - count)
        allowed = count < DAILY_EVAL_LIMIT

        if consume:
            self.log_eval_request_received(sid, source=source)

        if not allowed:
            logger.warning(
                "[SECURITY] 评测请求被拒绝 - session_id=%s - 原因：超过每日限额 - 当前次数=%d/%d",
                sid,
                count,
                DAILY_EVAL_LIMIT,
            )
            return QuotaCheckResult(
                allowed=False,
                current_count=count,
                daily_limit=DAILY_EVAL_LIMIT,
                remaining=0,
                message=f"今日评测次数已达上限（{DAILY_EVAL_LIMIT}/{DAILY_EVAL_LIMIT}），请明日再试",
            )

        if consume:
            count = self._increment_daily(sid)
            remaining = max(0, DAILY_EVAL_LIMIT - count)
            logger.info(
                "[SECURITY] 评测配额已消耗 - session_id=%s - 当前次数=%d/%d - 剩余=%d",
                sid,
                count,
                DAILY_EVAL_LIMIT,
                remaining,
            )

        logger.info(
            "[SECURITY] 评测配额检查通过 - session_id=%s - action=%s - 当前次数=%d/%d - 剩余=%d",
            sid,
            "consume" if consume else "check",
            count,
            DAILY_EVAL_LIMIT,
            remaining,
        )
        return QuotaCheckResult(
            allowed=True,
            current_count=count,
            daily_limit=DAILY_EVAL_LIMIT,
            remaining=remaining,
        )

    def check_duplicate_click(self, session_id: str) -> DuplicateClickResult:
        sid = (session_id or "anonymous").strip() or "anonymous"
        now = time.time()
        with self._lock:
            last = self._last_eval_at.get(sid)
            if last is not None:
                elapsed = now - last
                if elapsed < EVAL_COOLDOWN_SECONDS:
                    from datetime import datetime

                    last_str = datetime.fromtimestamp(last).strftime("%Y-%m-%d %H:%M:%S")
                    logger.warning(
                        "[SECURITY] 重复点击拦截 - session_id=%s - 上次请求时间=%s - 距现在=%.1f秒",
                        sid,
                        last_str,
                        elapsed,
                    )
                    return DuplicateClickResult(
                        allowed=False,
                        seconds_since_last=elapsed,
                        message=f"操作过于频繁，请 {int(EVAL_COOLDOWN_SECONDS - elapsed) + 1} 秒后再试",
                    )
            self._last_eval_at[sid] = now

        logger.info(
            "[SECURITY] 防重复点击检查通过 - session_id=%s - 冷却=%ds",
            sid,
            EVAL_COOLDOWN_SECONDS,
        )
        return DuplicateClickResult(allowed=True)


def log_api_key_policy_pass(*, context: str, session_id: str | None = None) -> None:
    logger.info(
        "[SECURITY] API Key 校验通过 - context=%s - session_id=%s - 未在请求中检测到服务器端 Key 存储",
        context,
        session_id or "n/a",
    )


def log_api_key_upload_rejected(session_id: str | None, *, endpoint: str) -> None:
    logger.warning(
        "[SECURITY] API Key 上传被拒绝 - session_id=%s - endpoint=%s - Key 仅允许浏览器本地存储",
        session_id or "n/a",
        endpoint,
    )


security_store = SecurityStore()
