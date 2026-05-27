"""讯飞 Spark Open API 的 model 参数映射与解析。"""

from __future__ import annotations

# 讯飞 API 接受的 model 值（小写）
SPARK_VALID_MODELS = frozenset({
    "lite",
    "pro",
    "pro-128k",
    "max",
    "max-32k",
    "ultra",
    "ultra-32k",
})

# 别名 -> API model（键均为小写）
SPARK_MODEL_ALIASES: dict[str, str] = {
    "spark lite": "lite",
    "spark-lite": "lite",
    "sparklite": "lite",
    "spark_lite": "lite",
    "lite": "lite",
    "spark pro-128k": "pro-128k",
    "spark pro 128k": "pro-128k",
    "spark-pro-128k": "pro-128k",
    "pro-128k": "pro-128k",
    "pro128k": "pro-128k",
    "spark pro": "pro",
    "spark-pro": "pro",
    "pro": "pro",
    "spark max-32k": "max-32k",
    "spark max 32k": "max-32k",
    "max-32k": "max-32k",
    "max32k": "max-32k",
    "spark max": "max",
    "spark-max": "max",
    "max": "max",
    "spark ultra-32k": "ultra-32k",
    "spark ultra 32k": "ultra-32k",
    "ultra-32k": "ultra-32k",
    "ultra32k": "ultra-32k",
    "spark ultra": "ultra",
    "spark-ultra": "ultra",
    "ultra": "ultra",
}


def is_spark_endpoint(url: str) -> bool:
    lower = (url or "").lower()
    return (
        "xf-yun.com" in lower
        or "xfyun.com" in lower
        or "spark-api-open" in lower
        or "spark-api.xf-yun" in lower
    )


def is_spark_context(url: str = "", name: str = "") -> bool:
    text = f"{url} {name}".lower()
    if is_spark_endpoint(text):
        return True
    if "讯飞" in f"{url} {name}":
        return True
    if "spark" in text and any(
        kw in text for kw in ("lite", "pro", "max", "ultra", "128", "32k")
    ):
        return True
    return False


def infer_spark_model_from_text(name: str = "", url: str = "", stored: str = "") -> str:
    """根据模型名称、URL、已存标识推断讯飞 API 的 model 参数。"""
    for candidate in (stored, name):
        key = (candidate or "").strip().lower()
        if key in SPARK_VALID_MODELS:
            return key
        if key in SPARK_MODEL_ALIASES:
            return SPARK_MODEL_ALIASES[key]

    combined = f"{name} {url} {stored}".lower()

    if "ultra" in combined and ("32k" in combined or "32-k" in combined or "32 k" in combined):
        return "ultra-32k"
    if "ultra" in combined:
        return "ultra"
    if "max" in combined and ("32k" in combined or "32-k" in combined or "32 k" in combined):
        return "max-32k"
    if "max" in combined:
        return "max"
    if "128k" in combined or "128-k" in combined or "128 k" in combined:
        return "pro-128k"
    if "pro" in combined:
        return "pro"
    if "lite" in combined:
        return "lite"

    return "lite"


def normalize_spark_model(stored: str, name: str = "", url: str = "") -> str:
    """
    将任意 stored/name 规范化为讯飞 API model 值。
    绝不返回 'default'。
    """
    mid = (stored or "").strip().lower()
    if mid in ("default", ""):
        return infer_spark_model_from_text(name, url, stored)
    if mid in SPARK_VALID_MODELS:
        return mid
    if mid in SPARK_MODEL_ALIASES:
        return SPARK_MODEL_ALIASES[mid]
    return infer_spark_model_from_text(name, url, stored)
