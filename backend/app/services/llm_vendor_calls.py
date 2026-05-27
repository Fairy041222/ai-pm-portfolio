"""各厂商独立调用实现（互不共用请求体构建逻辑）。"""

from __future__ import annotations

from typing import Any

from app.config import get_settings
from app.services.llm_common import (
    build_messages,
    extract_openai_content,
    failure_result,
    logged_http_post,
    parse_error_message,
    validate_api_endpoint,
    validate_api_key,
    usage_from_openai,
)
from app.services.spark_auth import (
    SPARK_HTTP_CHAT_URL,
    build_spark_bearer_headers,
    log_spark_auth_failure,
    resolve_spark_api_password,
    spark_auth_error_hint,
)
from app.services.llm_types import ChatResult
from app.services.model_invoke import ModelInvokeConfig
from app.services.model_runtime import ensure_api_model
from app.services.spark_model import is_spark_endpoint, normalize_spark_model

# DeepSeek 官方文档：POST https://api.deepseek.com/chat/completions
DEEPSEEK_CHAT_URL = "https://api.deepseek.com/chat/completions"

# Cursor 官方 Cloud Agents API 无 OpenAI chat 端点；OpenAI 兼容需用户自建代理
CURSOR_OFFICIAL_HOSTS = ("api.cursor.com", "cursor.com", "cursor.sh")


def _normalize_deepseek_model(model: str) -> str:
    m = (model or "").strip()
    aliases = {
        "deepseek-v4-flash": "deepseek-v4-flash",
        "deepseek-v4-pro": "deepseek-v4-pro",
        "deepseek-chat": "deepseek-chat",
        "deepseek-reasoner": "deepseek-reasoner",
    }
    return aliases.get(m, m or "deepseek-v4-flash")


def _deepseek_chat_url(config: ModelInvokeConfig) -> str:
    base = (config.base_url or "").strip().rstrip("/")
    if not base or "deepseek.com" in base:
        return DEEPSEEK_CHAT_URL
    if base.endswith("/chat/completions"):
        return base
    if base.endswith("/v1"):
        return f"{base}/chat/completions"
    return f"{base}/chat/completions"


def _is_cursor_official_host(base_url: str) -> bool:
    lower = base_url.lower()
    return any(host in lower for host in CURSOR_OFFICIAL_HOSTS)


async def call_deepseek(
    config: ModelInvokeConfig,
    user_content: str,
    *,
    system_prompt: str | None,
    max_tokens: int,
) -> ChatResult:
    key_err = validate_api_key(config)
    if key_err:
        return failure_result(config, key_err)

    url = _deepseek_chat_url(config)
    model = _normalize_deepseek_model(config.model)
    messages = build_messages(user_content, system_prompt)

    payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "max_tokens": int(max_tokens),
        "temperature": 0.7,
        "thinking": {"type": "disabled"},
        "stream": False,
    }
    headers = {
        "Authorization": f"Bearer {config.api_key}",
        "Content-Type": "application/json",
    }

    try:
        resp, raw, data = await logged_http_post(
            config,
            url,
            headers=headers,
            payload=payload,
            extra=f"vendor=deepseek",
        )

        if resp.status_code >= 400:
            err = parse_error_message(data, resp.status_code, raw)
            return failure_result(config, f"HTTP {resp.status_code}: {err}")

        content = extract_openai_content(data)
        pt, ct = usage_from_openai(data)
        return ChatResult(
            content=content or "（模型返回空内容）",
            success=bool(content),
            prompt_tokens=pt,
            completion_tokens=ct,
        )
    except TimeoutError as exc:
        return failure_result(config, str(exc))
    except Exception as exc:
        return failure_result(config, str(exc))


async def call_qwen(
    config: ModelInvokeConfig,
    user_content: str,
    *,
    system_prompt: str | None,
    max_tokens: int,
) -> ChatResult:
    key_err = validate_api_key(config)
    if key_err:
        return failure_result(config, key_err)
    endpoint_err = validate_api_endpoint(config)
    if endpoint_err:
        return failure_result(config, endpoint_err)

    base = config.base_url.rstrip("/")
    if "compatible-mode" in base:
        return await call_openai_compatible(
            config, user_content, system_prompt=system_prompt, max_tokens=max_tokens
        )

    url = f"{base}/services/aigc/text-generation/generation"
    messages = build_messages(user_content, system_prompt)
    payload = {
        "model": config.model,
        "input": {"messages": messages},
        "parameters": {
            "result_format": "message",
            "max_tokens": int(max_tokens),
            "temperature": 0.7,
        },
    }
    headers = {
        "Authorization": f"Bearer {config.api_key}",
        "Content-Type": "application/json",
    }

    try:
        resp, raw, data = await logged_http_post(
            config,
            url,
            headers=headers,
            payload=payload,
            extra="vendor=qwen",
        )

        if resp.status_code >= 400:
            err = parse_error_message(data, resp.status_code, raw)
            return failure_result(config, f"HTTP {resp.status_code}: {err}")

        if data.get("code"):
            err = f"{data.get('code')} - {data.get('message')}"
            return failure_result(config, err)

        output = data.get("output") or {}
        choices = output.get("choices") or []
        if choices:
            message = choices[0].get("message") or {}
            content = (message.get("content") or "").strip()
        else:
            text = output.get("text")
            content = (text or "").strip() if isinstance(text, str) else ""

        usage = data.get("usage") or {}
        return ChatResult(
            content=content or "（模型返回空内容）",
            success=bool(content),
            prompt_tokens=int(usage.get("input_tokens") or 0),
            completion_tokens=int(usage.get("output_tokens") or 0),
        )
    except TimeoutError as exc:
        return failure_result(config, str(exc))
    except Exception as exc:
        return failure_result(config, str(exc))


async def call_cursor_pro(
    config: ModelInvokeConfig,
    user_content: str,
    *,
    system_prompt: str | None,
    max_tokens: int,
) -> ChatResult:
    key_err = validate_api_key(config)
    if key_err:
        return failure_result(config, key_err)
    endpoint_err = validate_api_endpoint(config)
    if endpoint_err:
        return failure_result(config, endpoint_err)

    if _is_cursor_official_host(config.base_url):
        return failure_result(
            config,
            "Cursor 官方 API (api.cursor.com) 为 Cloud Agents 接口，不支持 POST /v1/chat/completions。"
            "请将 API 地址改为 OpenAI 兼容代理，例如本地 Cursor Bridge：http://127.0.0.1:8765/v1 ，"
            "或在 Cursor 集成中查看可用的兼容 Base URL；模型标识符请填代理支持的名称（如 composer-2）。",
        )

    proxy_config = ModelInvokeConfig(
        provider_type=config.provider_type,
        adapter="openai",
        vendor="cursor",
        api_key=config.api_key,
        base_url=config.base_url.rstrip("/"),
        model=config.model,
        display_name=config.display_name,
    )
    return await call_openai_compatible(
        proxy_config,
        user_content,
        system_prompt=system_prompt,
        max_tokens=max_tokens,
    )


def _resolve_openai_chat_url(base_url: str) -> str:
    """规范化 OpenAI 兼容 chat/completions URL，避免重复 /v1。"""
    base = (base_url or "").strip().rstrip("/")
    lower = base.lower()
    if lower.endswith("/chat/completions"):
        return base
    if lower.endswith("/v1"):
        return f"{base}/chat/completions"
    if "/v1/" in lower or lower.endswith("/v1"):
        return f"{base}/chat/completions"
    return f"{base}/v1/chat/completions"


async def call_spark(
    config: ModelInvokeConfig,
    user_content: str,
    *,
    system_prompt: str | None,
    max_tokens: int,
) -> ChatResult:
    """讯飞 Spark Open API：HTTP Bearer APIPassword（官方文档，无 HMAC）。"""
    key_err = validate_api_key(config)
    if key_err:
        return failure_result(config, key_err)

    settings = get_settings()
    api_password, cred_err = resolve_spark_api_password(
        config.api_key,
        fallback_env=settings.spark_api_password,
    )
    if cred_err:
        return failure_result(config, cred_err)

    api_model = normalize_spark_model(
        config.model,
        config.display_name,
        config.base_url,
    )
    url = SPARK_HTTP_CHAT_URL
    messages = build_messages(user_content, system_prompt)
    payload = {
        "model": api_model,
        "messages": messages,
        "max_tokens": int(max_tokens),
        "temperature": 0.7,
        "stream": False,
    }

    spark_config = ModelInvokeConfig(
        provider_type=config.provider_type,
        adapter="spark",
        vendor="spark",
        api_key=api_password,
        base_url=SPARK_HTTP_CHAT_URL.rsplit("/chat/completions", 1)[0],
        model=api_model,
        display_name=config.display_name,
        timeout_seconds=config.timeout_seconds,
    )

    headers = build_spark_bearer_headers(api_password)

    try:
        resp, raw, data = await logged_http_post(
            spark_config,
            url,
            headers=headers,
            payload=payload,
            extra="vendor=spark auth=bearer",
        )

        if resp.status_code >= 400:
            log_spark_auth_failure(
                status_code=resp.status_code,
                response_body=raw,
                url=url,
            )
            err = parse_error_message(data, resp.status_code, raw)
            err = spark_auth_error_hint(resp.status_code, err)
            return failure_result(spark_config, f"HTTP {resp.status_code}: {err}")

        content = extract_openai_content(data)
        pt, ct = usage_from_openai(data)
        return ChatResult(
            content=content or "（模型返回空内容）",
            success=bool(content),
            prompt_tokens=pt,
            completion_tokens=ct,
        )
    except TimeoutError as exc:
        return failure_result(spark_config, str(exc))
    except Exception as exc:
        return failure_result(spark_config, str(exc))


async def call_openai_compatible(
    config: ModelInvokeConfig,
    user_content: str,
    *,
    system_prompt: str | None,
    max_tokens: int,
    temperature: float = 0.7,
) -> ChatResult:
    key_err = validate_api_key(config)
    if key_err:
        return failure_result(config, key_err)
    endpoint_err = validate_api_endpoint(config)
    if endpoint_err:
        return failure_result(config, endpoint_err)

    base_url = config.base_url.rstrip("/")
    url = _resolve_openai_chat_url(base_url)
    messages = build_messages(user_content, system_prompt)

    api_model = ensure_api_model(
        config.model,
        vendor=config.vendor,
        name=config.display_name,
        url=base_url,
    )
    if config.vendor == "spark" or is_spark_endpoint(base_url) or is_spark_endpoint(url):
        api_model = normalize_spark_model(api_model, config.display_name, base_url)

    payload = {
        "model": api_model,
        "messages": messages,
        "max_tokens": int(max_tokens),
        "temperature": temperature,
        "stream": False,
    }
    headers = {
        "Authorization": f"Bearer {config.api_key}",
        "Content-Type": "application/json",
    }

    try:
        resp, raw, data = await logged_http_post(
            config,
            url,
            headers=headers,
            payload=payload,
            extra=f"vendor={config.vendor}",
        )

        if resp.status_code >= 400:
            err = parse_error_message(data, resp.status_code, raw)
            hint = ""
            if resp.status_code == 404 and "not found" in err.lower():
                hint = " 请检查 API 地址是否包含 /v1 以及是否支持 chat/completions。"
            return failure_result(config, f"HTTP {resp.status_code}: {err}{hint}")

        content = extract_openai_content(data)
        pt, ct = usage_from_openai(data)
        return ChatResult(
            content=content or "（模型返回空内容）",
            success=bool(content),
            prompt_tokens=pt,
            completion_tokens=ct,
        )
    except TimeoutError as exc:
        return failure_result(config, str(exc))
    except Exception as exc:
        return failure_result(config, str(exc))
