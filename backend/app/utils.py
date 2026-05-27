import uuid
from datetime import datetime


def new_id(prefix: str = "") -> str:
    uid = uuid.uuid4().hex[:12]
    return f"{prefix}{uid}" if prefix else uid


def format_datetime(dt: datetime | None = None) -> str:
    dt = dt or datetime.utcnow()
    return dt.strftime("%Y-%m-%d %H:%M")


def format_time(dt: datetime | None = None) -> str:
    dt = dt or datetime.utcnow()
    return dt.strftime("%H:%M")


def is_report_trigger_content(content: str) -> bool:
    import re

    return bool(
        re.search(
            r"生成报告|测试模型|对比评测|模型对比|大模型性能对比|性能对比报告",
            content.strip(),
            re.I,
        )
    )
