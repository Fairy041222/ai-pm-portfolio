"""API model 解析单元测试。"""
from app.services.endpoint_inference import parse_endpoint, resolve_runtime_model
from app.services.model_invoke import build_invoke_config_from_orm
from app.services.model_runtime import resolve_api_model
from app.models import ModelORM


def test_hy3_preview():
    mid = resolve_api_model(
        "tencent",
        "default",
        name="Hy3 preview",
        url="https://api.hunyuan.cloud.tencent.com/v1",
    )
    assert mid == "hy3-preview"


def test_hy3_user_config():
    mid = resolve_api_model("tencent", "hy3-preview", name="Hy3", url="")
    assert mid == "hy3-preview"


def test_spark_lite():
    assert resolve_api_model("spark", "default", name="Spark Lite", url="") == "lite"


def test_deepseek():
    mid = resolve_api_model("deepseek", "", name="DeepSeek", url="https://api.deepseek.com/v1")
    assert mid in ("deepseek-chat", "deepseek-v4-flash")


def test_qwen():
    mid = resolve_api_model("qwen", "", name="Qwen Max", url="")
    assert mid == "qwen-max"


def test_never_default():
    cases = [
        ("tencent", "Hy3 preview", "https://hunyuan.tencent.com/v1"),
        ("spark", "Spark Lite", "https://spark-api-open.xf-yun.com/v1"),
        ("deepseek", "Deepseek", "https://api.deepseek.com/v1"),
    ]
    for vendor, name, url in cases:
        mid = resolve_runtime_model(vendor, "default", name=name, url=url)  # type: ignore[arg-type]
        assert mid != "default", f"{vendor}/{name} returned default"
        assert mid, f"{vendor}/{name} returned empty"


def test_build_invoke_hy3():
    record = ModelORM(
        id="m1",
        name="Hy3 preview",
        provider_type="openai_compatible",
        api_endpoint="https://api.hunyuan.cloud.tencent.com/v1/chat/completions",
        model_identifier="default",
        api_key_encrypted="key",
        is_recommended=False,
    )
    cfg = build_invoke_config_from_orm(record)
    assert cfg.model == "hy3-preview"
    assert cfg.model != "default"


if __name__ == "__main__":
    test_hy3_preview()
    test_hy3_user_config()
    test_spark_lite()
    test_deepseek()
    test_qwen()
    test_never_default()
    test_build_invoke_hy3()
    print("All model runtime tests passed.")
