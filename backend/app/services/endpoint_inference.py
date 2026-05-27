"""根据 API 地址与名称自动推断提供商、模型标识与规范化 endpoint。"""

from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import urlparse

from typing import Literal

from app.services.model_runtime import infer_model_from_vendor, is_tencent_context, resolve_api_model
from app.services.spark_model import is_spark_context, is_spark_endpoint

VendorType = Literal["deepseek", "qwen", "cursor", "spark", "tencent", "openai_compatible"]

CHAT_SUFFIXES = (
    "/chat/completions",
    "/v1/chat/completions",
    "/services/aigc/text-generation/generation",
)


@dataclass(frozen=True)
class ParsedEndpoint:
    """解析后写入数据库的字段。"""

    api_endpoint: str
    provider_type: str  # openai_compatible | dashscope
    model_identifier: str
    vendor: VendorType


def _strip_chat_path(url: str) -> str:
    lower = url.lower().rstrip("/")
    for suffix in CHAT_SUFFIXES:
        if lower.endswith(suffix):
            return url[: len(url) - len(suffix)].rstrip("/")
    return url.rstrip("/")


def infer_vendor_from_text(url: str, name: str = "") -> VendorType:
    text = f"{url} {name}".lower()
    if is_spark_context(url, name):
        return "spark"
    if is_tencent_context(url, name):
        return "tencent"
    if "dashscope" in text or "aliyuncs" in text:
        return "qwen"
    if "deepseek" in text:
        return "deepseek"
    if "cursor" in text or "cursor.sh" in text or "curso" in text:
        return "cursor"
    return "openai_compatible"


def infer_provider_type(vendor: VendorType) -> str:
    if vendor == "qwen":
        return "dashscope"
    return "openai_compatible"


def _model_from_url_path(url: str) -> str | None:
    """从路径片段尝试提取 model（如 /models/qwen-plus/...）。"""
    parsed = urlparse(url)
    parts = [p for p in parsed.path.split("/") if p]
    for i, part in enumerate(parts):
        if part in ("models", "model") and i + 1 < len(parts):
            candidate = parts[i + 1]
            if candidate not in ("v1", "v0", "api", "chat", "completions"):
                return candidate
    match = re.search(r"[?&]model=([^&]+)", url)
    if match:
        return match.group(1).strip()
    return None


def parse_endpoint(raw: str, name: str = "", *, user_api_model: str = "") -> ParsedEndpoint:
    """
    将用户填写的 API 地址规范化为可存储的 base URL，并推断 provider / model。
    user_api_model：用户显式填写的 model，优先于自动推断。
    """
    original = (raw or "").strip()
    if not original:
        raise ValueError("API 地址不能为空")

    if not original.startswith(("http://", "https://")):
        original = f"https://{original}"

    api_endpoint = _strip_chat_path(original)
    vendor = infer_vendor_from_text(api_endpoint, name)
    provider_type = infer_provider_type(vendor)

    model_from_path = _model_from_url_path(original)
    stored = (user_api_model or model_from_path or "").strip()
    model_identifier = resolve_api_model(
        vendor,
        stored or None,
        name=name,
        url=api_endpoint,
    )

    return ParsedEndpoint(
        api_endpoint=api_endpoint,
        provider_type=provider_type,
        model_identifier=model_identifier,
        vendor=vendor,
    )


def resolve_runtime_model(
    vendor: VendorType,
    stored_model: str,
    name: str = "",
    url: str = "",
) -> str:
    """调用时解析实际 API model 参数。"""
    if is_spark_endpoint(url) or is_spark_context(url, name):
        vendor = "spark"
    elif is_tencent_context(url, name):
        vendor = "tencent"

    return resolve_api_model(vendor, stored_model, name=name, url=url)
