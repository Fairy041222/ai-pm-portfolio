"""运行时 API model 参数解析：优先使用用户配置，禁止向厂商 API 发送 default。"""

from __future__ import annotations

from typing import Literal

from app.services.spark_model import (
    infer_spark_model_from_text,
    is_spark_context,
    is_spark_endpoint,
    normalize_spark_model,
)

VendorType = Literal["deepseek", "qwen", "cursor", "spark", "tencent", "openai_compatible"]

INVALID_MODEL_IDS = frozenset({"", "default", "none", "null"})


def is_valid_stored_model(stored: str | None) -> bool:
    s = (stored or "").strip().lower()
    return bool(s) and s not in INVALID_MODEL_IDS


def is_tencent_context(url: str = "", name: str = "") -> bool:
    text = f"{url} {name}".lower()
    return any(
        kw in text
        for kw in (
            "tencent",
            "tencentcloud",
            "hunyuan",
            "hy3",
            "hunyuancloud",
            "cloud.tencent.com",
        )
    )


def infer_tencent_model(name: str = "", url: str = "") -> str:
    combined = f"{name} {url}".lower()
    if "hy3" in combined or "hunyuan" in combined:
        return "hy3-preview"
    return "hy3-preview"


def infer_deepseek_model(name: str = "", url: str = "") -> str:
    combined = f"{name} {url}".lower()
    if "reasoner" in combined:
        return "deepseek-reasoner"
    if "flash" in combined:
        return "deepseek-v4-flash"
    if "pro" in combined:
        return "deepseek-v4-pro"
    if "chat" in combined:
        return "deepseek-chat"
    return "deepseek-chat"


def infer_qwen_model(name: str = "", url: str = "") -> str:
    combined = f"{name} {url}".lower()
    if "max" in combined:
        return "qwen-max"
    if "turbo" in combined:
        return "qwen-turbo"
    return "qwen-plus"


def infer_cursor_model(name: str = "", url: str = "") -> str:
    combined = f"{name} {url}".lower()
    if "composer" in combined:
        return "composer-2"
    if "gpt-4" in combined:
        return "gpt-4o"
    return "composer-2"


def infer_model_from_vendor(vendor: VendorType, name: str = "", url: str = "") -> str:
    if vendor == "spark" or is_spark_context(url, name):
        return infer_spark_model_from_text(name, url, "")
    if vendor == "tencent" or is_tencent_context(url, name):
        return infer_tencent_model(name, url)
    if vendor == "deepseek":
        return infer_deepseek_model(name, url)
    if vendor == "qwen":
        return infer_qwen_model(name, url)
    if vendor == "cursor":
        return infer_cursor_model(name, url)
    if is_tencent_context(url, name):
        return infer_tencent_model(name, url)
    if is_spark_endpoint(url):
        return infer_spark_model_from_text(name, url, "")
    return ""


def resolve_api_model(
    vendor: VendorType | str,
    stored: str | None,
    *,
    name: str = "",
    url: str = "",
) -> str:
    """
    解析发往厂商 API 的 model 字段。
    1. 用户配置的 model_identifier（DB / 表单）
    2. 按 vendor + 名称/URL 推断
    绝不返回 default。
    """
    v = (vendor or "openai_compatible").strip()

    if is_valid_stored_model(stored):
        mid = stored.strip()
        if v == "spark" or is_spark_context(url, name):
            return normalize_spark_model(mid, name, url)
        return mid

    if v == "spark" or is_spark_context(url, name):
        return normalize_spark_model(stored or "", name, url)

    inferred = infer_model_from_vendor(v, name, url)  # type: ignore[arg-type]
    if inferred:
        return inferred

    if is_tencent_context(url, name):
        return infer_tencent_model(name, url)
    if is_spark_context(url, name):
        return infer_spark_model_from_text(name, url, stored or "")

    return infer_deepseek_model(name, url) if v == "deepseek" else ""


def ensure_api_model(model: str, *, vendor: str, name: str, url: str) -> str:
    """调用前最终校验；若仍为空则抛出可读错误。"""
    resolved = model.strip() if model else ""
    if resolved.lower() in INVALID_MODEL_IDS:
        resolved = resolve_api_model(vendor, None, name=name, url=url)
    if not resolved or resolved.lower() in INVALID_MODEL_IDS:
        raise ValueError(
            f"【{name}】未配置有效的 API model 名称。"
            f"请在模型编辑中填写 model（如 hy3-preview、lite、deepseek-chat）。"
        )
    return resolved
