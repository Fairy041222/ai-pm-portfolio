"""讯飞星火 HTTP Open API 鉴权：仅 Bearer APIPassword（无 HMAC）。"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

# 官方 HTTP 接口地址（Spark Lite 等 Open API）
SPARK_HTTP_CHAT_URL = "https://spark-api-open.xf-yun.com/v1/chat/completions"
SPARK_HTTP_BASE_URL = "https://spark-api-open.xf-yun.com/v1"


def resolve_spark_api_password(user_credential: str, *, fallback_env: str = "") -> tuple[str, str | None]:
    """
    解析 APIPassword。
    优先使用环境变量/配置中的 fallback_env，否则使用用户在浏览器保存的凭证。
    HTTP 接口不接受 APIKey:APISecret 格式（会触发网关 HMAC 校验并报 401）。
    """
    env_password = (fallback_env or "").strip()
    if env_password:
        logger.info("[SparkAuth] 使用环境变量/配置中的 APIPassword，前缀=%s...", env_password[:8])
        return env_password, None

    raw = (user_credential or "").strip()
    if not raw:
        return "", "未配置 APIPassword。请在模型设置中填写，或设置环境变量 SPARK_API_PASSWORD。"

    if ":" in raw:
        return "", (
            "HTTP 接口仅支持 Bearer APIPassword，不支持 APIKey:APISecret。"
            "请到讯飞控制台 Spark Lite 页面复制「HTTP 服务接口认证信息」中的 APIPassword。"
        )

    logger.info("[SparkAuth] Bearer APIPassword，前缀=%s...", raw[:8])
    return raw, None


def build_spark_bearer_headers(api_password: str) -> dict[str, str]:
    """标准 HTTP Bearer 鉴权头。"""
    return {
        "Authorization": f"Bearer {api_password}",
        "Content-Type": "application/json",
    }


def log_spark_auth_failure(*, status_code: int, response_body: str, url: str) -> None:
    """认证/调用失败时记录状态码与响应体（不含完整密钥）。"""
    body_preview = (response_body or "").strip().replace("\n", " ")[:500]
    logger.error(
        "[SparkAuth] 请求失败 url=%s status=%s body=%s",
        url,
        status_code,
        body_preview or "(empty)",
    )


def spark_auth_error_hint(status: int, err: str) -> str:
    if status == 401:
        return (
            f"{err}。请确认填写的是 Spark Lite 控制台「HTTP 服务接口认证信息」中的 APIPassword，"
            "而非 WebSocket 的 APIKey/API Secret；API 地址应为 "
            f"{SPARK_HTTP_CHAT_URL}"
        )
    return err
