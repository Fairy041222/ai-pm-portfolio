"""讯飞 Spark model 参数解析单元测试。"""
from app.services.endpoint_inference import parse_endpoint, resolve_runtime_model
from app.services.model_invoke import build_invoke_config_from_orm
from app.services.spark_model import normalize_spark_model
from app.models import ModelORM


def test_spark_lite_from_name():
    assert normalize_spark_model("default", "Spark Lite", "https://spark-api-open.xf-yun.com/v1") == "lite"
    assert normalize_spark_model("", "讯飞 Spark Lite", "") == "lite"


def test_spark_variants():
    cases = [
        ("Spark Pro", "pro"),
        ("Spark Pro-128K", "pro-128k"),
        ("Spark Max", "max"),
        ("Spark Max-32K", "max-32k"),
        ("Spark Ultra", "ultra"),
        ("Spark Ultra-32K", "ultra-32k"),
    ]
    for name, expected in cases:
        got = normalize_spark_model("default", name, "https://spark-api-open.xf-yun.com/v1")
        assert got == expected, f"{name} -> {got}, want {expected}"


def test_parse_endpoint_spark():
    parsed = parse_endpoint(
        "https://spark-api-open.xf-yun.com/v1/chat/completions",
        "Spark Lite",
    )
    assert parsed.vendor == "spark"
    assert parsed.model_identifier == "lite"
    assert parsed.model_identifier != "default"


def test_resolve_runtime_never_default():
    mid = resolve_runtime_model(
        "spark",
        "default",
        name="Spark Lite",
        url="https://spark-api-open.xf-yun.com/v1",
    )
    assert mid == "lite"
    assert mid != "default"


def test_build_invoke_config():
    record = ModelORM(
        id="model_test",
        name="Spark Lite",
        provider_type="openai_compatible",
        api_endpoint="https://spark-api-open.xf-yun.com/v1/chat/completions",
        model_identifier="default",
        api_key_encrypted="test-key",
        is_recommended=False,
    )
    cfg = build_invoke_config_from_orm(record)
    assert cfg.vendor == "spark"
    assert cfg.model == "lite"
    assert cfg.model != "default"


if __name__ == "__main__":
    test_spark_lite_from_name()
    test_spark_variants()
    test_parse_endpoint_spark()
    test_resolve_runtime_never_default()
    test_build_invoke_config()
    print("All spark model tests passed.")
