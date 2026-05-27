"""加载 config/models.yaml 并提供预设模型与厂商适配器配置。"""

from __future__ import annotations

import logging
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml

logger = logging.getLogger(__name__)

_CONFIG_PATH = Path(__file__).resolve().parents[2] / "config" / "models.yaml"


def _deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    out = dict(base)
    for key, val in override.items():
        if isinstance(val, dict) and isinstance(out.get(key), dict):
            out[key] = _deep_merge(out[key], val)
        else:
            out[key] = val
    return out


@lru_cache(maxsize=1)
def load_models_config() -> dict[str, Any]:
    if not _CONFIG_PATH.is_file():
        logger.warning("[ModelRegistry] 配置文件不存在: %s", _CONFIG_PATH)
        return {"version": 1, "global_defaults": {}, "vendors": {}, "models": []}
    with _CONFIG_PATH.open(encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    logger.info(
        "[ModelRegistry] 已加载 models.yaml version=%s presets=%d vendors=%d",
        data.get("version"),
        len(data.get("models") or []),
        len(data.get("vendors") or {}),
    )
    return data


def get_global_defaults() -> dict[str, Any]:
    return dict(load_models_config().get("global_defaults") or {})


def get_vendor_config(vendor: str) -> dict[str, Any]:
    vendors = load_models_config().get("vendors") or {}
    return dict(vendors.get(vendor) or vendors.get("openai_compatible") or {})


def list_vendor_ids() -> list[str]:
    return list((load_models_config().get("vendors") or {}).keys())


def list_model_presets(*, include_disabled: bool = False) -> list[dict[str, Any]]:
    defaults = get_global_defaults()
    presets: list[dict[str, Any]] = []
    for raw in load_models_config().get("models") or []:
        if not isinstance(raw, dict):
            continue
        if not include_disabled and not raw.get("enabled", True):
            continue
        merged = _deep_merge(defaults, raw)
        presets.append(merged)
    return presets


def get_preset_by_id(preset_id: str) -> dict[str, Any] | None:
    for preset in list_model_presets(include_disabled=True):
        if preset.get("preset_id") == preset_id:
            return preset
    return None


def preset_to_api_schema(preset: dict[str, Any]) -> dict[str, Any]:
    """转为 API 响应（camelCase 由 Pydantic schema 处理）。"""
    return {
        "preset_id": preset.get("preset_id", ""),
        "name": preset.get("name", ""),
        "enabled": bool(preset.get("enabled", True)),
        "vendor": preset.get("vendor", "openai_compatible"),
        "api_endpoint": preset.get("api_endpoint", ""),
        "api_model": preset.get("api_model", ""),
        "is_recommended": bool(preset.get("is_recommended", False)),
        "max_tokens": int(preset.get("max_tokens", 1024)),
        "temperature": float(preset.get("temperature", 0.7)),
        "timeout_seconds": int(preset.get("timeout_seconds", 18)),
        "description": preset.get("description", ""),
        "adapter": get_vendor_config(str(preset.get("vendor", ""))).get(
            "adapter", "openai_compatible"
        ),
    }


def build_registry_payload() -> dict[str, Any]:
    cfg = load_models_config()
    vendors = {
        vid: dict(vconf)
        for vid, vconf in (cfg.get("vendors") or {}).items()
        if isinstance(vconf, dict)
    }
    return {
        "version": cfg.get("version", 1),
        "global_defaults": get_global_defaults(),
        "vendors": vendors,
        "presets": [preset_to_api_schema(p) for p in list_model_presets()],
    }
