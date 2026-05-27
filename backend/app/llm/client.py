"""NFR-M3：模型调用层统一入口。业务层通过 LlmClient 调用，不直接依赖各厂商实现。"""

from __future__ import annotations

from app.services.llm_service import chat_completion_with_metrics
from app.services.llm_types import ChatResult
from app.services.model_invoke import ModelInvokeConfig, vendor_to_adapter
from app.services.model_registry import get_global_defaults, get_preset_by_id, get_vendor_config

__all__ = ["LlmClient", "ChatResult", "ModelInvokeConfig"]


class LlmClient:
    """统一 LLM 调用接口。"""

    @staticmethod
    def defaults() -> dict:
        return get_global_defaults()

    @staticmethod
    def vendor_config(vendor: str) -> dict:
        return get_vendor_config(vendor)

    @staticmethod
    async def chat(
        user_content: str,
        *,
        invoke_config: ModelInvokeConfig,
        system_prompt: str | None = None,
        max_tokens: int | None = None,
        temperature: float | None = None,
    ) -> str:
        result = await LlmClient.chat_with_metrics(
            user_content,
            invoke_config=invoke_config,
            system_prompt=system_prompt,
            max_tokens=max_tokens,
            temperature=temperature,
        )
        return result.content

    @staticmethod
    async def chat_with_metrics(
        user_content: str,
        *,
        invoke_config: ModelInvokeConfig,
        system_prompt: str | None = None,
        max_tokens: int | None = None,
        temperature: float | None = None,
    ) -> ChatResult:
        defaults = get_global_defaults()
        effective_max = max_tokens if max_tokens is not None else int(defaults.get("max_tokens", 1024))
        _ = temperature
        return await chat_completion_with_metrics(
            user_content,
            invoke_config=invoke_config,
            system_prompt=system_prompt,
            max_tokens=effective_max,
        )

    @staticmethod
    async def chat_by_preset_id(
        preset_id: str,
        user_content: str,
        *,
        api_key: str,
        system_prompt: str | None = None,
    ) -> ChatResult:
        preset = get_preset_by_id(preset_id)
        if not preset:
            raise ValueError(f"未知预设模型: {preset_id}")
        vendor = str(preset.get("vendor", "openai_compatible"))
        vconf = get_vendor_config(vendor)
        adapter = vendor_to_adapter(vendor)  # type: ignore[arg-type]
        config = ModelInvokeConfig(
            provider_type=str(vconf.get("adapter", "openai_compatible")),
            adapter=adapter,
            vendor=vendor,  # type: ignore[arg-type]
            api_key=api_key,
            base_url=str(preset.get("api_endpoint", "")),
            model=str(preset.get("api_model", "")),
            display_name=str(preset.get("name", preset_id)),
        )
        return await LlmClient.chat_with_metrics(
            user_content,
            invoke_config=config,
            system_prompt=system_prompt,
            max_tokens=int(preset.get("max_tokens", 1024)),
            temperature=float(preset.get("temperature", 0.7)),
        )
