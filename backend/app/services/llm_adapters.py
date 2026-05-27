"""按模型 vendor 路由到独立调用函数。"""

from __future__ import annotations

import copy
from typing import Any

from app.services.llm_common import (
    build_messages,
    failure_result,
    logged_http_request,
    parse_error_message,
    validate_api_key,
)
from app.services.llm_types import ChatResult
from app.services.llm_vendor_calls import (
    call_cursor_pro,
    call_deepseek,
    call_openai_compatible,
    call_qwen,
    call_spark,
)
from app.services.model_invoke import ModelInvokeConfig


def _extract_by_path(data: Any, path: str) -> str | None:
    current = data
    for part in path.split("."):
        if isinstance(current, dict):
            if part.isdigit():
                idx = int(part)
                if isinstance(current.get("choices"), list) and idx < len(current["choices"]):
                    current = current["choices"][idx]
                else:
                    return None
            else:
                current = current.get(part)
        elif isinstance(current, list) and part.isdigit():
            idx = int(part)
            current = current[idx] if idx < len(current) else None
        else:
            return None
        if current is None:
            return None
    if isinstance(current, str):
        return current.strip()
    return None


def _substitute_value(
    value: Any,
    *,
    config: ModelInvokeConfig,
    messages: list[dict[str, str]],
    max_tokens: int,
) -> Any:
    if isinstance(value, str):
        if value == "{{messages}}":
            return messages
        if value == "{{max_tokens}}":
            return int(max_tokens)
        return (
            value.replace("{{api_key}}", config.api_key)
            .replace("{{model}}", config.model)
            .replace("{{max_tokens}}", str(max_tokens))
            .replace("{{base_url}}", config.base_url)
        )
    if isinstance(value, dict):
        return {
            k: _substitute_value(v, config=config, messages=messages, max_tokens=max_tokens)
            for k, v in value.items()
        }
    if isinstance(value, list):
        return [
            _substitute_value(v, config=config, messages=messages, max_tokens=max_tokens)
            for v in value
        ]
    return value


async def invoke_custom_template(
    config: ModelInvokeConfig,
    user_content: str,
    *,
    system_prompt: str | None,
    max_tokens: int,
) -> ChatResult:
    key_err = validate_api_key(config)
    if key_err:
        return failure_result(config, key_err)

    template = config.custom_request_template or {}
    messages = build_messages(user_content, system_prompt)

    url_suffix = template.get("url_suffix", "/chat/completions")
    url = template.get("url") or f"{config.base_url.rstrip('/')}{url_suffix}"
    method = (template.get("method") or "POST").upper()
    headers = _substitute_value(
        copy.deepcopy(template.get("headers") or {}),
        config=config,
        messages=messages,
        max_tokens=max_tokens,
    )
    body = _substitute_value(
        copy.deepcopy(template.get("body") or {}),
        config=config,
        messages=messages,
        max_tokens=max_tokens,
    )

    try:
        resp, data = await logged_http_request(
            config,
            method,
            url,
            headers=headers,
            json_body=body,
            extra="adapter=custom",
        )

        if resp.status_code >= 400:
            err = parse_error_message(data, resp.status_code, resp.text)
            return failure_result(config, f"HTTP {resp.status_code}: {err}")

        paths = template.get("response_paths") or ["choices.0.message.content"]
        content = ""
        for path in paths:
            extracted = _extract_by_path(data, path)
            if extracted:
                content = extracted
                break

        return ChatResult(content=content or "（模型返回空内容）", success=bool(content))
    except Exception as exc:
        return failure_result(config, str(exc))


async def invoke_model(
    config: ModelInvokeConfig,
    user_content: str,
    *,
    system_prompt: str | None = None,
    max_tokens: int = 4096,
) -> ChatResult:
    vendor = config.vendor
    print(f"[LLM路由] {config.display_name} -> vendor={vendor}")

    if vendor == "deepseek":
        return await call_deepseek(
            config, user_content, system_prompt=system_prompt, max_tokens=max_tokens
        )
    if vendor == "qwen":
        return await call_qwen(
            config, user_content, system_prompt=system_prompt, max_tokens=max_tokens
        )
    if vendor == "cursor":
        return await call_cursor_pro(
            config, user_content, system_prompt=system_prompt, max_tokens=max_tokens
        )
    if vendor == "spark":
        return await call_spark(
            config, user_content, system_prompt=system_prompt, max_tokens=max_tokens
        )
    if vendor == "custom":
        return await invoke_custom_template(
            config, user_content, system_prompt=system_prompt, max_tokens=max_tokens
        )
    return await call_openai_compatible(
        config, user_content, system_prompt=system_prompt, max_tokens=max_tokens
    )
