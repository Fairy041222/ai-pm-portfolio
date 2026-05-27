"""LLM 调用公共工具：消息构建、Key 校验、日志与错误解析。"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass
from typing import Any

import httpx

from app.services.model_invoke import ModelInvokeConfig
from app.services.model_registry import get_global_defaults, get_vendor_config

logger = logging.getLogger(__name__)

RETRYABLE_STATUS = frozenset({408, 429, 500, 502, 503, 504})


def build_messages(user_content: str, system_prompt: str | None) -> list[dict[str, str]]:
    messages: list[dict[str, str]] = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({"role": "user", "content": user_content})
    return messages


def mask_api_key_for_log(api_key: str | None) -> str:
    """日志用 Key 掩码，仅显示前缀，如 sk-abcd..."""
    key = (api_key or "").strip()
    if not key:
        return "(未配置)"
    if len(key) <= 8:
        return f"{key[:4]}..."
    return f"{key[:8]}..."


def resolve_http_timeout(config: ModelInvokeConfig, override: float | None = None) -> float:
    if override is not None and override > 0:
        return float(override)
    if config.timeout_seconds is not None and config.timeout_seconds > 0:
        return float(config.timeout_seconds)
    vconf = get_vendor_config(config.vendor)
    vendor_timeout = vconf.get("timeout_seconds")
    if vendor_timeout:
        return float(vendor_timeout)
    defaults = get_global_defaults()
    return float(defaults.get("timeout_seconds") or 60)


def resolve_retry_policy() -> tuple[int, float]:
    defaults = get_global_defaults()
    max_attempts = int(defaults.get("retry_max_attempts") or 3)
    base_delay = float(defaults.get("retry_base_delay_seconds") or 1.0)
    return max(1, max_attempts), max(0.2, base_delay)


def timeout_error_message(config: ModelInvokeConfig, timeout: float) -> str:
    return (
        f"请求超时（已等待 {int(timeout)} 秒）。"
        f"可在 config/models.yaml 中为厂商 {config.vendor} 调整 timeout_seconds，"
        f"或在右侧编辑模型时增大超时（当前全局默认见 models.yaml global_defaults）。"
    )


def format_vendor_error(
    config: ModelInvokeConfig,
    message: str,
    *,
    status: int | None = None,
) -> str:
    timeout_sec = resolve_http_timeout(config)
    prefix = f"【{config.display_name} 调用失败】"
    if status:
        prefix = f"【{config.display_name} 调用失败 HTTP {status}】"
    hint = f"（当前超时配置约 {int(timeout_sec)} 秒，可在 models.yaml 或模型编辑中调整）"
    if "timeout" in message.lower() or "超时" in message:
        return f"{prefix}{message} {hint}"
    return f"{prefix}{message}"


def validate_api_key(config: ModelInvokeConfig) -> str | None:
    """返回错误文案；Key 有效时返回 None。"""
    key = (config.api_key or "").strip()
    if not key:
        return (
            f"【{config.display_name}】未配置 API Key。"
            f"请在「模型选择」中编辑该模型并填写 Key。"
        )
    if key in ("sk-", "sk-your-key", "your-api-key"):
        return f"【{config.display_name}】API Key 仍为占位符，请填写真实密钥。"
    return None


def validate_api_endpoint(config: ModelInvokeConfig) -> str | None:
    endpoint = (config.base_url or "").strip()
    if not endpoint:
        return f"【{config.display_name}】未配置 API 地址 (endpoint)。"
    if not endpoint.startswith(("http://", "https://")):
        return f"【{config.display_name}】API 地址格式无效，需以 http:// 或 https:// 开头。"
    return None


@dataclass
class LlmCallLogContext:
    config: ModelInvokeConfig
    url: str
    started_at: float


def log_request_start(config: ModelInvokeConfig, url: str, *, extra: str = "") -> LlmCallLogContext:
    """记录 LLM 请求开始，返回上下文供 finish 计算耗时。"""
    masked_key = mask_api_key_for_log(config.api_key)
    msg = (
        f"[LLM API 调用] 模型={config.display_name} | "
        f"URL={url} | Key={masked_key} | api_model={config.model}"
    )
    if extra:
        msg += f" | {extra}"
    print(msg)
    logger.info(msg)
    return LlmCallLogContext(
        config=config,
        url=url,
        started_at=time.perf_counter(),
    )


def log_response(
    config: ModelInvokeConfig,
    status_code: int,
    *,
    ok: bool,
    detail: str = "",
    url: str | None = None,
    duration_ms: float | None = None,
) -> None:
    """记录 LLM 响应结果（含状态码与耗时）。"""
    status_label = str(status_code) if status_code else "N/A"
    duration_label = f"{duration_ms:.0f}ms" if duration_ms is not None else "N/A"
    target_url = url or config.base_url
    msg = (
        f"[LLM API 响应] 模型={config.display_name} | "
        f"URL={target_url} | 耗时={duration_label} | "
        f"状态码={status_label} | 成功={ok}"
    )
    if detail:
        msg += f" | {detail[:200]}"
    print(msg)
    logger.info(msg)


def finish_llm_call(
    ctx: LlmCallLogContext,
    status_code: int,
    *,
    ok: bool,
    detail: str = "",
) -> None:
    duration_ms = (time.perf_counter() - ctx.started_at) * 1000
    log_response(
        ctx.config,
        status_code,
        ok=ok,
        detail=detail,
        url=ctx.url,
        duration_ms=duration_ms,
    )


async def logged_http_post(
    config: ModelInvokeConfig,
    url: str,
    *,
    headers: dict[str, str],
    payload: dict[str, Any],
    timeout: float | None = None,
    extra: str = "",
) -> tuple[httpx.Response, str, Any]:
    """带详细日志、超时与指数退避重试的 HTTP POST。"""
    effective_timeout = timeout if timeout is not None else resolve_http_timeout(config)
    max_attempts, base_delay = resolve_retry_policy()
    ctx = log_request_start(
        config,
        url,
        extra=f"{extra} | timeout={int(effective_timeout)}s | retries={max_attempts}",
    )
    last_exc: Exception | None = None

    for attempt in range(max_attempts):
        try:
            async with httpx.AsyncClient(timeout=effective_timeout) as client:
                resp = await client.post(url, headers=headers, json=payload)
                raw = resp.text
                try:
                    data = resp.json()
                except json.JSONDecodeError:
                    data = {"raw": raw}

            if resp.status_code in RETRYABLE_STATUS and attempt < max_attempts - 1:
                delay = base_delay * (2**attempt)
                logger.warning(
                    "[LLM] 可重试 HTTP %s，%ss 后第 %d 次重试",
                    resp.status_code,
                    delay,
                    attempt + 2,
                )
                await asyncio.sleep(delay)
                continue

            ok = resp.status_code < 400
            detail = f"响应长度={len(raw)}"
            if not ok:
                detail = parse_error_message(data, resp.status_code, raw)
            finish_llm_call(ctx, resp.status_code, ok=ok, detail=detail)
            return resp, raw, data
        except (httpx.TimeoutException, httpx.ConnectError, httpx.ReadError) as exc:
            last_exc = exc
            if attempt < max_attempts - 1:
                delay = base_delay * (2**attempt)
                logger.warning(
                    "[LLM] 网络/超时异常 %s，%ss 后第 %d 次重试",
                    exc,
                    delay,
                    attempt + 2,
                )
                await asyncio.sleep(delay)
                continue
            finish_llm_call(ctx, 0, ok=False, detail=str(exc))
            raise TimeoutError(timeout_error_message(config, effective_timeout)) from exc
        except Exception as exc:
            finish_llm_call(ctx, 0, ok=False, detail=str(exc))
            raise

    finish_llm_call(ctx, 0, ok=False, detail=str(last_exc or "unknown"))
    if last_exc:
        raise last_exc
    raise RuntimeError("logged_http_post exhausted retries without response")


async def logged_http_request(
    config: ModelInvokeConfig,
    method: str,
    url: str,
    *,
    headers: dict[str, Any],
    json_body: dict[str, Any] | None = None,
    timeout: float = 120.0,
    extra: str = "",
) -> tuple[httpx.Response, Any]:
    """带详细日志的通用 HTTP 请求（custom adapter 用）。"""
    ctx = log_request_start(config, url, extra=extra or f"method={method}")
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.request(method, url, headers=headers, json=json_body)
            try:
                data = resp.json()
            except json.JSONDecodeError:
                data = {"raw": resp.text}

        ok = resp.status_code < 400
        detail = ""
        if not ok:
            detail = parse_error_message(data, resp.status_code, resp.text)
        finish_llm_call(ctx, resp.status_code, ok=ok, detail=detail)
        return resp, data
    except Exception as exc:
        finish_llm_call(ctx, 0, ok=False, detail=str(exc))
        raise


def parse_error_message(data: Any, status_code: int, raw_text: str = "") -> str:
    if isinstance(data, dict):
        err = data.get("error")
        if isinstance(err, dict):
            for key in ("message", "msg", "detail", "type"):
                val = err.get(key)
                if val:
                    return str(val)
        for key in ("message", "msg", "detail", "code"):
            val = data.get(key)
            if val:
                return str(val)
    if raw_text and raw_text.strip():
        return raw_text.strip()[:400]
    return f"HTTP {status_code}"


def failure_result(config: ModelInvokeConfig, error_msg: str):
    from app.services.llm_types import ChatResult

    return ChatResult(
        content=format_vendor_error(config, error_msg[:500]),
        success=False,
        error=error_msg,
    )


def extract_openai_content(data: dict[str, Any]) -> str:
    choices = data.get("choices") or []
    if not choices:
        return ""
    message = choices[0].get("message") or {}
    return (message.get("content") or "").strip()


def usage_from_openai(data: dict[str, Any]) -> tuple[int, int]:
    usage = data.get("usage") or {}
    return int(usage.get("prompt_tokens") or 0), int(usage.get("completion_tokens") or 0)
