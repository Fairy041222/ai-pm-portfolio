"""浏览器端 LLM 转发代理（解决厂商 API 无 CORS 问题）。

API Key 仅用于当次请求转发至厂商，不在服务端持久化或写入日志明文。
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from app.schemas import LlmProxyRequest, LlmProxyResponse
from app.services.endpoint_inference import parse_endpoint
from app.services.llm_service import chat_completion_with_metrics
from app.services.model_invoke import ModelInvokeConfig, vendor_to_adapter
from app.services.model_registry import get_vendor_config
from app.services.model_runtime import ensure_api_model, resolve_api_model

router = APIRouter(prefix="/api/proxy", tags=["proxy"])

_PROXY_VENDORS = frozenset({"spark", "tencent", "qwen", "deepseek", "openai_compatible"})


def _build_invoke_config(body: LlmProxyRequest, vendor: str) -> ModelInvokeConfig:
    key = (body.api_key or "").strip()
    if not key:
        raise HTTPException(status_code=400, detail="缺少 API Key")

    endpoint = (body.api_endpoint or "").strip()
    if not endpoint:
        raise HTTPException(status_code=400, detail="缺少 API 地址")

    name = (body.name or "").strip() or vendor
    try:
        parsed = parse_endpoint(endpoint, name)
        base_url = parsed.api_endpoint
    except ValueError:
        base_url = endpoint.rstrip("/")

    model = resolve_api_model(vendor, body.api_model or "", name=name, url=base_url)
    model = ensure_api_model(model, vendor=vendor, name=name, url=base_url)

    provider_type = {
        "deepseek": "openai_compatible",
        "qwen": "dashscope",
        "spark": "openai_compatible",
        "tencent": "openai_compatible",
        "cursor": "openai_compatible",
    }.get(vendor, "openai_compatible")

    return ModelInvokeConfig(
        provider_type=provider_type,
        adapter=vendor_to_adapter(vendor),  # type: ignore[arg-type]
        vendor=vendor,  # type: ignore[arg-type]
        api_key=key,
        base_url=base_url,
        model=model,
        display_name=name,
        timeout_seconds=float(body.timeout_seconds) if body.timeout_seconds > 0 else None,
    )


async def _proxy_chat(body: LlmProxyRequest, vendor: str) -> LlmProxyResponse:
    config = _build_invoke_config(body, vendor)
    max_tokens = body.max_tokens if body.max_tokens > 0 else 1024

    result = await chat_completion_with_metrics(
        body.user_content,
        invoke_config=config,
        system_prompt=body.system_prompt,
        max_tokens=max_tokens,
    )
    return LlmProxyResponse(
        content=result.content,
        success=result.success,
        prompt_tokens=result.prompt_tokens,
        completion_tokens=result.completion_tokens,
        error=result.error,
    )


@router.post("/xunfei", response_model=LlmProxyResponse)
async def proxy_xunfei(body: LlmProxyRequest) -> LlmProxyResponse:
    """转发讯飞星火 Open API（浏览器无法直连，需经此后端代理）。"""
    return await _proxy_chat(body, "spark")


@router.post("/llm", response_model=LlmProxyResponse)
async def proxy_llm(body: LlmProxyRequest) -> LlmProxyResponse:
    """通用 LLM 代理：仅允许 models.yaml 中标记 browser_proxy 的厂商。"""
    vendor = (body.vendor or "").strip().lower()
    if vendor not in _PROXY_VENDORS:
        raise HTTPException(status_code=400, detail=f"不支持的厂商: {vendor or '(空)'}")

    vconf = get_vendor_config(vendor)
    if not vconf.get("browser_proxy"):
        raise HTTPException(
            status_code=400,
            detail=f"厂商 {vendor} 未启用浏览器代理，请直连或检查 models.yaml",
        )
    return await _proxy_chat(body, vendor)
