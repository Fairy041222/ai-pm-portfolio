"""从数据库模型记录构建 LLM 调用配置（无内置/硬编码厂商逻辑）。"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Literal

from app.models import ModelORM
from app.services.crypto_service import decrypt_api_key
from app.services.endpoint_inference import infer_vendor_from_text, parse_endpoint, resolve_runtime_model
from app.services.model_runtime import ensure_api_model, resolve_api_model

ProviderType = Literal["openai_compatible", "dashscope", "custom"]
AdapterType = Literal["openai", "dashscope", "custom", "deepseek", "cursor", "spark", "tencent"]
VendorType = Literal["deepseek", "qwen", "cursor", "spark", "tencent", "openai_compatible", "custom"]

PROVIDER_TO_ADAPTER: dict[str, AdapterType] = {
    "openai_compatible": "openai",
    "dashscope": "dashscope",
    "custom": "custom",
}

VENDOR_TO_CALLER = {
    "deepseek": "deepseek",
    "qwen": "qwen",
    "cursor": "cursor",
    "spark": "spark",
    "tencent": "openai",
    "openai_compatible": "openai",
    "custom": "custom",
}

DEFAULT_CUSTOM_TEMPLATE: dict[str, Any] = {
    "url_suffix": "/chat/completions",
    "method": "POST",
    "headers": {
        "Authorization": "Bearer {{api_key}}",
        "Content-Type": "application/json",
    },
    "body": {
        "model": "{{model}}",
        "messages": "{{messages}}",
        "max_tokens": "{{max_tokens}}",
        "temperature": 0.7,
    },
    "response_paths": ["choices.0.message.content", "output.text", "message.content"],
}


@dataclass
class ModelInvokeConfig:
    provider_type: str
    adapter: AdapterType
    vendor: VendorType
    api_key: str
    base_url: str
    model: str
    display_name: str
    custom_request_template: dict[str, Any] | None = None
    timeout_seconds: float | None = None


def infer_vendor(record: ModelORM) -> VendorType:
    """按 endpoint / 名称识别厂商。"""
    url = record.api_endpoint or ""
    name = record.name or ""
    vendor = infer_vendor_from_text(url, name)
    if vendor != "openai_compatible":
        return vendor
    pt = (record.provider_type or "openai_compatible").strip()
    if pt == "dashscope":
        return "qwen"
    return "openai_compatible"


def vendor_to_adapter(vendor: VendorType) -> AdapterType:
    if vendor == "deepseek":
        return "deepseek"
    if vendor == "qwen":
        return "dashscope"
    if vendor == "cursor":
        return "cursor"
    if vendor == "spark":
        return "spark"
    if vendor == "tencent":
        return "tencent"
    if vendor == "custom":
        return "custom"
    return "openai"


def _parse_custom_template(raw: str | None) -> dict[str, Any] | None:
    if not raw or not raw.strip():
        return None
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else None
    except json.JSONDecodeError:
        return None


def build_invoke_config_from_orm(record: ModelORM) -> ModelInvokeConfig:
    vendor = infer_vendor(record)
    provider_type = (record.provider_type or "openai_compatible").strip()
    if vendor in ("deepseek", "qwen", "cursor", "spark", "tencent"):
        provider_type = {
            "deepseek": "openai_compatible",
            "qwen": "dashscope",
            "cursor": "openai_compatible",
            "spark": "openai_compatible",
            "tencent": "openai_compatible",
        }[vendor]

    if provider_type not in PROVIDER_TO_ADAPTER:
        provider_type = "openai_compatible"

    adapter = vendor_to_adapter(vendor)
    api_key = (decrypt_api_key(record.api_key_encrypted) or "").strip()
    raw_url = (record.api_endpoint or "").strip()
    try:
        parsed = parse_endpoint(raw_url, record.name or "")
        base_url = parsed.api_endpoint
        model_id = resolve_runtime_model(
            vendor,
            record.model_identifier or parsed.model_identifier,
            name=record.name,
            url=base_url,
        )
    except ValueError:
        base_url = raw_url.rstrip("/")
        model_id = resolve_api_model(
            vendor,
            record.model_identifier,
            name=record.name or "",
            url=base_url,
        )

    model_id = ensure_api_model(
        model_id,
        vendor=vendor,
        name=record.name or "",
        url=base_url,
    )

    template = None

    return ModelInvokeConfig(
        provider_type=provider_type,
        adapter=adapter,
        vendor=vendor,
        api_key=api_key,
        base_url=base_url,
        model=model_id,
        display_name=record.name,
        custom_request_template=template,
    )
