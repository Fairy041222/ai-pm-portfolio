"""评测耗时估算（用于进度 ETA 与前端「预计总时间」）。"""

from __future__ import annotations

from app.services.test_case_generator import DEFAULT_TEST_CASE_COUNT


def estimate_eval_duration_seconds(
    num_models: int,
    num_cases: int = DEFAULT_TEST_CASE_COUNT,
    *,
    max_concurrent: int = 9,
    seconds_per_wave: float = 12.0,
) -> int:
    """并发评测下的粗估总时长（秒）。"""
    num_models = max(1, num_models)
    num_cases = max(1, num_cases)
    total_requests = num_models * num_cases
    waves = (total_requests + max(1, max_concurrent) - 1) // max(1, max_concurrent)
    # 用例生成 ~3s + 并发 API 波次 + 报告组装/落库 ~5s
    return int(min(55, 3 + waves * seconds_per_wave + 5))
