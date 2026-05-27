"""讯飞 Spark Bearer 鉴权单元测试。"""
from app.services.spark_auth import (
    SPARK_HTTP_CHAT_URL,
    build_spark_bearer_headers,
    resolve_spark_api_password,
)


def test_bearer_headers():
    headers = build_spark_bearer_headers("my-api-password-123456")
    assert headers["Authorization"] == "Bearer my-api-password-123456"
    assert headers["Content-Type"] == "application/json"


def test_resolve_api_password():
    pwd, err = resolve_spark_api_password("  secret-token  ")
    assert err is None
    assert pwd == "secret-token"


def test_reject_key_secret_format():
    pwd, err = resolve_spark_api_password("apikey:apisecret12345678")
    assert not pwd
    assert err and "APIPassword" in err


def test_env_fallback():
    pwd, err = resolve_spark_api_password("", fallback_env="env-password")
    assert err is None
    assert pwd == "env-password"


def test_spark_url_constant():
    assert SPARK_HTTP_CHAT_URL == "https://spark-api-open.xf-yun.com/v1/chat/completions"


if __name__ == "__main__":
    test_bearer_headers()
    test_resolve_api_password()
    test_reject_key_secret_format()
    test_env_fallback()
    test_spark_url_constant()
    print("spark_auth tests passed")
