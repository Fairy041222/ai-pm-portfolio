from app.config import get_settings
from app.services.llm_adapters import invoke_model
from app.services.llm_types import ChatResult
from app.services.model_invoke import ModelInvokeConfig

__all__ = [
    "ChatResult",
    "chat_completion",
    "chat_completion_with_metrics",
    "ModelInvokeConfig",
]


async def chat_completion(
    user_content: str,
    *,
    invoke_config: ModelInvokeConfig,
    system_prompt: str | None = None,
    max_tokens: int | None = None,
) -> str:
    result = await chat_completion_with_metrics(
        user_content,
        invoke_config=invoke_config,
        system_prompt=system_prompt,
        max_tokens=max_tokens,
    )
    return result.content


async def chat_completion_with_metrics(
    user_content: str,
    *,
    invoke_config: ModelInvokeConfig,
    system_prompt: str | None = None,
    max_tokens: int | None = None,
) -> ChatResult:
    settings = get_settings()
    effective_max_tokens = max_tokens if max_tokens is not None else settings.openai_chat_max_tokens
    config = invoke_config

    if not config.api_key:
        return ChatResult(
            content=(
                f"【{config.display_name}】未配置 API Key。"
                f"请在模型设置中填写 Key 后重试。\n\n测试问题：{user_content[:500]}"
            ),
            success=False,
            error="missing_api_key",
        )

    if not config.base_url:
        return ChatResult(
            content=f"【{config.display_name}】未配置 API 地址。",
            success=False,
            error="missing_api_endpoint",
        )

    result = await invoke_model(
        config,
        user_content,
        system_prompt=system_prompt,
        max_tokens=effective_max_tokens,
    )

    if result.success:
        print(
            f"[LLM] vendor={config.vendor} model={config.model} "
            f"completion_tokens={result.completion_tokens}"
        )
    return result
