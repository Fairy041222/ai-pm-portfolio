"""根据用户业务场景动态生成测试用例。"""

from __future__ import annotations

import asyncio

import json
import logging
import re
from dataclasses import dataclass

from app.config import get_settings
from app.services.llm_service import chat_completion
from app.services.model_invoke import ModelInvokeConfig

logger = logging.getLogger(__name__)

# PRD：评测总时长控制在 1 分钟内，默认 3 条用例，最多 5 条
MIN_TEST_CASE_COUNT = 1
DEFAULT_TEST_CASE_COUNT = 3
MAX_TEST_CASE_COUNT = 5


@dataclass
class TestCase:
    id: str
    input: str
    category: str  # normal | boundary | abnormal


SCENARIO_LABELS = {
    "express-delivery": "快递派送",
    "plant-health": "植物健康",
    "generic": "通用业务",
}


# --- 快递派送场景 ---
EXPRESS_DELIVERY_CASES: list[tuple[str, str, str]] = [
    ("tc-ex-1", "快件物流显示已签收，但收件人反馈未收到包裹，应如何核实与处理？", "normal"),
    ("tc-ex-2", "派送员上门时收件人电话无人接听，按规定应尝试几次、间隔多久？", "normal"),
    ("tc-ex-3", "客户要求将已出库包裹改派到同小区另一楼栋，标准操作流程是什么？", "normal"),
    ("tc-ex-4", "收件地址门牌号有误但街道正确，是否可先派送并由客户协助转交？", "boundary"),
    ("tc-ex-5", "大促期间网点爆仓，预计延迟 2–3 天送达，如何向客户说明并降低投诉？", "boundary"),
    ("tc-ex-6", "收件人拒收并声称未下单，要求立即退回，派送员应如何处置与上报？", "abnormal"),
]

# --- 植物健康场景（仅当用户明确涉及植物时使用）---
PLANT_HEALTH_CASES: list[tuple[str, str, str]] = [
    ("tc-ph-1", "我的绿萝叶子发黄了，是什么原因？", "normal"),
    ("tc-ph-2", "如何判断多肉植物是否浇水过多？", "normal"),
    ("tc-ph-3", "月季花上有白色粉末状物质，怎么处理？", "normal"),
    ("tc-ph-4", "发财树掉叶子怎么办？", "normal"),
    ("tc-ph-5", "如何治疗植物根腐病？", "normal"),
    ("tc-ph-6", "哪些植物适合放在卧室？", "boundary"),
    ("tc-ph-7", "植物叶子边缘焦枯是什么原因？", "boundary"),
    ("tc-ph-8", "这株植物已经枯死了还能救活吗？茎完全干枯、根系发黑腐烂。", "abnormal"),
]


def detect_scenario(user_content: str) -> str:
    """根据用户描述识别业务场景，禁止默认落到植物场景。"""
    text = (user_content or "").strip().lower()
    if not text:
        return "generic"

    express_keywords = (
        "快递", "派送", "派件", "物流", "签收", "拒收", "揽收", "配送",
        "派件员", "快递员", "地址错误", "派送超时", "延误", "退回",
        "末端", "驿站", "投递", "运单", "包裹", "delivery", "express",
    )
    if any(kw in text for kw in express_keywords):
        return "express-delivery"

    plant_keywords = (
        "植物", "绿萝", "多肉", "月季", "发财树", "浇水", "施肥",
        "叶子发黄", "根腐", "病虫害", "园艺", "盆栽", "养护",
    )
    if any(kw in text for kw in plant_keywords):
        return "plant-health"

    return "generic"


def get_system_prompt(scenario: str, user_content: str) -> str:
    if scenario == "express-delivery":
        return (
            "你是一位熟悉快递与末端派送业务的专家。请用中文回答与快件派送、签收异常、"
            "地址问题、拒收退回、联系不上收件人、延误投诉等相关的问题。"
            "回答应结合实操流程，条理清晰，给出可执行的处理建议。"
        )
    if scenario == "plant-health":
        return (
            "你是一位专业的植物健康与室内园艺顾问。请用中文回答用户关于植物养护、病虫害、"
            "浇水施肥等问题，给出清晰、可操作的诊断与处理建议。"
        )
    snippet = (user_content or "通用业务咨询").strip()[:400]
    return (
        f"你是业务场景 AI 助手。当前评测场景描述：{snippet}\n"
        "请用中文专业回答下列测试问题，回答应紧扣上述业务场景，"
        "条理分明，给出可落地的建议，不要偏离场景。"
    )


def _cases_from_tuples(rows: list[tuple[str, str, str]]) -> list[TestCase]:
    return [TestCase(id=i, input=q, category=c) for i, q, c in rows]


def _append_user_seed(cases: list[TestCase], user_content: str) -> list[TestCase]:
    """将用户原始诉求作为一条补充用例（若与现有题库不重复）。"""
    snippet = (user_content or "").strip()
    if len(snippet) < 8:
        return cases
    core = snippet[:220]
    if any(core in c.input or c.input in core for c in cases):
        return cases
    question = core if core.endswith(("？", "?", "。")) else f"{core}？"
    return [TestCase(id="tc-user-seed", input=question, category="normal"), *cases]


def _pick_balanced_cases(
    cases: list[TestCase],
    count: int = DEFAULT_TEST_CASE_COUNT,
) -> list[TestCase]:
    """从候选集中选取指定数量，尽量覆盖 normal / boundary / abnormal。"""
    count = max(MIN_TEST_CASE_COUNT, min(MAX_TEST_CASE_COUNT, count))
    if len(cases) <= count:
        return cases

    normals = [c for c in cases if c.category == "normal"]
    boundaries = [c for c in cases if c.category == "boundary"]
    abnormals = [c for c in cases if c.category == "abnormal"]
    picked: list[TestCase] = []
    seen_ids: set[str] = set()

    def take(pool: list[TestCase], n: int) -> None:
        for item in pool:
            if len(picked) >= count or n <= 0:
                break
            if item.id in seen_ids:
                continue
            picked.append(item)
            seen_ids.add(item.id)
            n -= 1

    if count >= 3:
        take(normals, 2)
        take(boundaries, 1)
        take(abnormals, max(0, count - len(picked)))
    elif count == 2:
        take(normals, 1)
        take(boundaries, 1)
    else:
        take(normals, 1)

    for item in cases:
        if len(picked) >= count:
            break
        if item.id not in seen_ids:
            picked.append(item)
            seen_ids.add(item.id)

    return picked[:count]


def finalize_test_cases(
    cases: list[TestCase],
    *,
    target: int = DEFAULT_TEST_CASE_COUNT,
) -> list[TestCase]:
    """统一裁剪到 PRD 允许范围（默认 3，最多 5）。"""
    target = max(MIN_TEST_CASE_COUNT, min(MAX_TEST_CASE_COUNT, target))
    if not cases:
        cases = _generic_template_cases("")
    return _pick_balanced_cases(cases, target)


def _generic_template_cases(user_content: str) -> list[TestCase]:
    """无 LLM 时根据用户文本生成通用模板用例（默认 3 条）。"""
    topic = (user_content or "该业务场景").strip()[:80]
    return [
        TestCase("tc-g-1", f"在{topic}下，最常见的正常业务流程是什么？请分步骤说明。", "normal"),
        TestCase("tc-g-2", f"针对{topic}，一线人员应掌握哪些核心操作规范？", "normal"),
        TestCase("tc-g-3", f"在{topic}中，信息不完整或规则模糊时如何处理？", "boundary"),
    ]


async def _llm_generate_test_cases(
    user_content: str,
    invoke_config: ModelInvokeConfig,
    *,
    target_count: int = DEFAULT_TEST_CASE_COUNT,
) -> list[TestCase]:
    """调用 LLM 根据用户场景动态生成测试用例。"""
    target_count = max(MIN_TEST_CASE_COUNT, min(MAX_TEST_CASE_COUNT, target_count))
    prompt = f"""请根据以下业务场景描述，生成 {target_count} 条用于评测大语言模型的测试问题（最多不超过 {MAX_TEST_CASE_COUNT} 条）。

业务场景描述：
{user_content}

要求：
- 共 {target_count} 条，其中至少 1 条正常场景（category: normal），可含边界（boundary）或异常（abnormal）
- 所有问题必须与上述业务场景直接相关，不要使用无关领域（如植物、医疗等除非场景本身如此）
- 仅输出 JSON 数组，不要其他文字。格式：
[{{"id":"tc-1","input":"问题文本","category":"normal"}}]"""

    raw = await chat_completion(prompt, max_tokens=900, invoke_config=invoke_config)
    if raw.startswith("【"):
        return []

    text = raw.strip()
    match = re.search(r"\[[\s\S]*\]", text)
    if not match:
        return []

    try:
        data = json.loads(match.group())
    except json.JSONDecodeError:
        logger.warning("Failed to parse LLM test cases JSON")
        return []

    cases: list[TestCase] = []
    for i, item in enumerate(data):
        if not isinstance(item, dict):
            continue
        q = str(item.get("input", "")).strip()
        cat = str(item.get("category", "normal")).strip().lower()
        if cat not in ("normal", "boundary", "abnormal"):
            cat = "normal"
        if not q:
            continue
        cases.append(
            TestCase(
                id=str(item.get("id", f"tc-llm-{i + 1}")),
                input=q,
                category=cat,
            )
        )
    return finalize_test_cases(cases)


async def generate_test_cases(
    scenario: str,
    user_content: str = "",
    *,
    invoke_config: ModelInvokeConfig | None = None,
    target_count: int = DEFAULT_TEST_CASE_COUNT,
) -> list[TestCase]:
    """根据场景与用户问题生成测试用例（默认 3 条，最多 5 条）。"""
    target_count = max(MIN_TEST_CASE_COUNT, min(MAX_TEST_CASE_COUNT, target_count))
    print(
        f"[测试用例生成] 场景={scenario}, 目标数量={target_count}, "
        f"用户问题={user_content[:200]!r}"
    )

    if scenario == "express-delivery":
        cases = _cases_from_tuples(EXPRESS_DELIVERY_CASES)
        cases = _append_user_seed(cases, user_content)
        result = finalize_test_cases(cases, target=target_count)
        print(f"[测试用例生成] 快递场景最终 {len(result)} 条用例")
        return result

    if scenario == "plant-health":
        cases = _cases_from_tuples(PLANT_HEALTH_CASES)
        cases = _append_user_seed(cases, user_content)
        result = finalize_test_cases(cases, target=target_count)
        print(f"[测试用例生成] 植物场景最终 {len(result)} 条用例")
        return result

    llm_cases: list[TestCase] = []
    settings = get_settings()
    if settings.eval_use_llm_test_cases and invoke_config and invoke_config.api_key:
        try:
            llm_cases = await asyncio.wait_for(
                _llm_generate_test_cases(
                    user_content,
                    invoke_config,
                    target_count=target_count,
                ),
                timeout=settings.eval_case_gen_timeout_seconds,
            )
        except asyncio.TimeoutError:
            logger.warning("LLM 生成测试用例超时，回退到模板用例")
            llm_cases = []
    if len(llm_cases) >= MIN_TEST_CASE_COUNT:
        print(f"[测试用例生成] LLM 生成 {len(llm_cases)} 条用例")
        return llm_cases

    cases = _generic_template_cases(user_content)
    cases = _append_user_seed(cases, user_content)
    result = finalize_test_cases(cases, target=target_count)
    print(f"[测试用例生成] 使用通用模板最终 {len(result)} 条用例")
    return result


def generate_test_cases_sync(
    scenario: str,
    user_content: str = "",
    *,
    target_count: int = DEFAULT_TEST_CASE_COUNT,
) -> list[TestCase]:
    """同步版本（mock / 降级，不调用 LLM）。"""
    target_count = max(MIN_TEST_CASE_COUNT, min(MAX_TEST_CASE_COUNT, target_count))
    print(
        f"[测试用例生成-sync] 场景={scenario}, 目标数量={target_count}, "
        f"用户问题={user_content[:200]!r}"
    )

    if scenario == "express-delivery":
        cases = _append_user_seed(_cases_from_tuples(EXPRESS_DELIVERY_CASES), user_content)
        return finalize_test_cases(cases, target=target_count)
    if scenario == "plant-health":
        cases = _append_user_seed(_cases_from_tuples(PLANT_HEALTH_CASES), user_content)
        return finalize_test_cases(cases, target=target_count)
    cases = _append_user_seed(_generic_template_cases(user_content), user_content)
    return finalize_test_cases(cases, target=target_count)


def estimate_test_case_count(scenario: str) -> int:
    """生成用例阶段的预估数量，用于进度展示（与 DEFAULT_TEST_CASE_COUNT 一致）。"""
    _ = scenario
    return DEFAULT_TEST_CASE_COUNT


def summarize_categories(test_cases: list[TestCase], scenario: str) -> str:
    normal_count = sum(1 for tc in test_cases if tc.category == "normal")
    boundary_count = sum(1 for tc in test_cases if tc.category == "boundary")
    abnormal_count = sum(1 for tc in test_cases if tc.category == "abnormal")
    label = SCENARIO_LABELS.get(scenario, "业务")
    return (
        f"{len(test_cases)}条（{label}场景：正常{normal_count} + "
        f"边界{boundary_count} + 异常{abnormal_count}）"
    )
