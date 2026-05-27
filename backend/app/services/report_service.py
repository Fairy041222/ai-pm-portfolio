"""多模型评测与报告生成。"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from dataclasses import dataclass

from app.config import get_settings
from app.models import ModelORM
from app.schemas import (
    ModelConItemSchema,
    ModelReportSchema,
    ReportDataSchema,
    TestCaseResultSchema,
)
from app.services.evaluation_progress import progress_store
from app.services.llm_service import chat_completion_with_metrics
from app.services.model_invoke import ModelInvokeConfig, build_invoke_config_from_orm
from app.services.report_renderer import render_report_intro, render_report_markdown
from app.services.test_case_generator import (
    TestCase,
    detect_scenario,
    estimate_test_case_count,
    generate_test_cases,
    generate_test_cases_sync,
    get_system_prompt,
    summarize_categories,
    SCENARIO_LABELS,
)
from app.utils import format_datetime, is_report_trigger_content, new_id

logger = logging.getLogger(__name__)

COST_PER_1K_TOKENS: dict[str, float] = {
    "gpt-4o": 0.01,
    "gpt-4o-mini": 0.003,
    "gpt-3.5-turbo": 0.002,
    "deepseek-chat": 0.001,
    "default": 0.004,
}

MAX_CONCURRENT_EVAL = 9
MAX_OUTPUT_CHARS = 4000


def _model_eval_step_label(model: EvalModel) -> str:
    return f"评测{model.name}"


def _update_progress(task_id: str, **kwargs) -> None:
    progress_store.update(task_id, **kwargs)


@dataclass
class EvalModel:
    id: str
    name: str
    invoke: ModelInvokeConfig


@dataclass
class _EvalCell:
    model_id: str
    test_case_id: str
    result: TestCaseResultSchema
    elapsed_seconds: float
    success: bool
    prompt_tokens: int
    completion_tokens: int


def _format_duration(seconds: float) -> str:
    if seconds < 1:
        return f"{round(seconds * 1000)}ms"
    return f"{seconds:.1f}s"


def _estimate_cost_usd(api_model: str, prompt_tokens: int, completion_tokens: int) -> float:
    rate = COST_PER_1K_TOKENS.get(api_model, COST_PER_1K_TOKENS["default"])
    total_tokens = prompt_tokens + completion_tokens
    return max(0.0001, (total_tokens / 1000.0) * rate)


def _format_cost(usd: float) -> str:
    if usd < 0.01:
        return f"${usd:.4f}"
    return f"${usd:.2f}"


def _truncate_output(text: str) -> str:
    text = text.strip()
    if len(text) <= MAX_OUTPUT_CHARS:
        return text
    return text[: MAX_OUTPUT_CHARS - 3] + "..."


def _build_pros_cons(
    success_rate: float,
    avg_seconds: float,
    failure_count: int,
    scenario: str,
) -> tuple[list[str], list[ModelConItemSchema]]:
    label = SCENARIO_LABELS.get(scenario, "目标")
    pros: list[str] = []
    cons: list[ModelConItemSchema] = []

    if success_rate >= 0.9:
        pros.append(f"{label}场景准确率高")
        pros.append("回答结构清晰、建议可执行")
    elif success_rate >= 0.75:
        pros.append(f"多数{label}问题回答可靠")
    else:
        cons.append(ModelConItemSchema(text=f"部分{label}复杂场景回答失败", level="error"))

    if avg_seconds <= 2.5:
        pros.append("响应速度快")
    elif avg_seconds > 5.0:
        cons.append(ModelConItemSchema(text="响应耗时偏长", level="warning"))

    if failure_count > 0:
        cons.append(
            ModelConItemSchema(
                text=f"{failure_count} 个用例未成功响应",
                level="warning" if failure_count <= 2 else "error",
            )
        )

    if not pros:
        pros.append(f"具备{label}场景基础知识")

    return pros, cons


def _model_score(success_rate: float, avg_seconds: float, total_cost: float) -> float:
    speed_score = max(0.0, 1.0 - avg_seconds / 10.0)
    cost_score = max(0.0, 1.0 - total_cost / 0.5)
    return success_rate * 0.65 + speed_score * 0.25 + cost_score * 0.10


async def _evaluate_one(
    model: EvalModel,
    test_case: TestCase,
    semaphore: asyncio.Semaphore,
    system_prompt: str,
) -> _EvalCell:
    settings = get_settings()
    timeout = settings.eval_api_timeout_seconds
    max_tokens = settings.eval_max_tokens_per_case

    async with semaphore:
        start = time.perf_counter()
        prompt_tokens = 0
        completion_tokens = 0
        try:
            chat = await asyncio.wait_for(
                chat_completion_with_metrics(
                    test_case.input,
                    invoke_config=model.invoke,
                    system_prompt=system_prompt,
                    max_tokens=max_tokens,
                ),
                timeout=timeout,
            )
            elapsed = time.perf_counter() - start

            success = chat.success and not chat.content.startswith("【")
            output = _truncate_output(chat.content) if success else chat.content
            prompt_tokens = chat.prompt_tokens
            completion_tokens = chat.completion_tokens

            if not success:
                logger.warning(
                    "模型 %s 用例 %s 调用未成功: %s",
                    model.name,
                    test_case.id,
                    chat.error or output[:120],
                )
        except asyncio.TimeoutError:
            elapsed = time.perf_counter() - start
            logger.warning(
                "模型 %s 用例 %s 超时 (>%ss)",
                model.name,
                test_case.id,
                timeout,
            )
            success = False
            output = f"【超时】模型响应超过 {int(timeout)} 秒，已跳过"
        except Exception as exc:
            elapsed = time.perf_counter() - start
            logger.exception("模型 %s 用例 %s 评测异常", model.name, test_case.id)
            success = False
            output = f"【评测异常】{str(exc)[:300]}"

        result = TestCaseResultSchema(
            id=f"{model.id}-{test_case.id}",
            input=test_case.input,
            output=output,
            time=_format_duration(elapsed),
            status="success" if success else "failure",
        )

        return _EvalCell(
            model_id=model.id,
            test_case_id=test_case.id,
            result=result,
            elapsed_seconds=elapsed,
            success=success,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
        )


async def run_evaluation(
    test_cases: list[TestCase],
    models: list[EvalModel],
    conversation_id: str,
    scenario: str,
    user_content: str,
    task_id: str | None = None,
) -> ReportDataSchema:
    if len(models) < 1:
        raise ValueError("至少需要 1 个模型参与评测")
    if not test_cases:
        raise ValueError("测试用例不能为空")

    system_prompt = get_system_prompt(scenario, user_content)
    print(f"[模型评测] 场景={scenario}, 用例数={len(test_cases)}, 模型数={len(models)}")
    print(f"[模型评测] system_prompt 前120字: {system_prompt[:120]}...")

    wall_start = time.perf_counter()
    total_per_model = len(test_cases)
    num_models = len(models)
    total_cells = total_per_model * num_models
    settings = get_settings()
    eval_semaphore = asyncio.Semaphore(settings.eval_max_concurrent_requests)

    if task_id:
        _update_progress(
            task_id,
            progress=20,
            current_step=f"并发评测 {num_models} 个模型",
            completed_cases=0,
            total_cases=total_per_model,
        )

    by_model: dict[str, list[_EvalCell]] = {m.id: [] for m in models}
    case_done_count: dict[str, int] = {tc.id: 0 for tc in test_cases}
    completed_cells = 0
    progress_lock = asyncio.Lock()

    async def run_one_cell(model: EvalModel, test_case: TestCase) -> None:
        nonlocal completed_cells
        cell = await _evaluate_one(model, test_case, eval_semaphore, system_prompt)
        async with progress_lock:
            by_model[model.id].append(cell)
            case_done_count[test_case.id] = case_done_count.get(test_case.id, 0) + 1
            completed_cells += 1
            cases_fully_done = sum(
                1 for n in case_done_count.values() if n >= num_models
            )
            pct = 20 + (60.0 * completed_cells / max(total_cells, 1))
            if task_id:
                _update_progress(
                    task_id,
                    progress=int(min(80, pct)),
                    current_step=_model_eval_step_label(model),
                    completed_cases=min(cases_fully_done, total_per_model),
                    total_cases=total_per_model,
                )

    await asyncio.gather(
        *(run_one_cell(model, test_case) for model in models for test_case in test_cases)
    )

    for model in models:
        by_model[model.id] = sorted(by_model[model.id], key=lambda c: c.test_case_id)

    if task_id:
        _update_progress(
            task_id,
            progress=85,
            current_step="生成报告",
            completed_cases=total_per_model,
            total_cases=total_per_model,
        )

    model_reports: list[ModelReportSchema] = []
    scores: list[tuple[float, ModelReportSchema]] = []

    for model in models:
        model_cells = by_model[model.id]
        if not model_cells:
            logger.warning("模型 %s 无任何评测结果，生成失败占位行", model.name)
            model_cells = [
                _EvalCell(
                    model_id=model.id,
                    test_case_id=tc.id,
                    result=TestCaseResultSchema(
                        id=f"{model.id}-{tc.id}",
                        input=tc.input,
                        output="【调用失败】该模型未返回评测数据",
                        time="N/A",
                        status="failure",
                    ),
                    elapsed_seconds=0.0,
                    success=False,
                    prompt_tokens=0,
                    completion_tokens=0,
                )
                for tc in test_cases
            ]
        total = len(model_cells)
        successes = sum(1 for c in model_cells if c.success)
        success_rate = successes / total if total else 0.0
        avg_seconds = (
            sum(c.elapsed_seconds for c in model_cells) / total if total else 0.0
        )
        total_cost = sum(
            _estimate_cost_usd(model.invoke.model, c.prompt_tokens, c.completion_tokens)
            for c in model_cells
        )

        test_case_results = sorted(model_cells, key=lambda c: c.test_case_id)
        pros, cons = _build_pros_cons(
            success_rate,
            avg_seconds,
            total - successes,
            scenario,
        )

        report_model = ModelReportSchema(
            id=model.id,
            name=model.name,
            success_rate=f"{round(success_rate * 100, 1)}%",
            avg_time=_format_duration(avg_seconds),
            cost=_format_cost(total_cost),
            pros=pros,
            cons=cons,
            test_cases=[c.result for c in test_case_results],
        )
        model_reports.append(report_model)
        scores.append((_model_score(success_rate, avg_seconds, total_cost), report_model))

    scores.sort(key=lambda x: x[0], reverse=True)
    if not scores:
        raise ValueError("所有模型评测均无有效结果，无法生成报告")
    best = scores[0][1]
    label = SCENARIO_LABELS.get(scenario, "业务")

    total_seconds = int(time.perf_counter() - wall_start)
    duration_label = (
        f"{total_seconds}秒" if total_seconds <= 60 else f"约 {total_seconds // 60} 分 {total_seconds % 60} 秒"
    )

    print(f"[模型评测] 报告包含 {len(model_reports)} 个模型: {[m.name for m in model_reports]}")

    if task_id:
        _update_progress(task_id, progress=95, current_step="生成报告")

    try:
        report = ReportDataSchema(
            id=new_id("report-"),
            conversation_id=conversation_id,
            generated_at=format_datetime(),
            test_case_count=len(test_cases),
            test_case_summary=summarize_categories(test_cases, scenario),
            total_duration=duration_label,
            total_duration_seconds=total_seconds,
            best_model=best.name,
            recommendation_reason=(
                f"{best.name} 在{label}场景 AI 评测中综合表现最佳：成功率 {best.success_rate}，"
                f"平均响应 {best.avg_time}，估算成本 {best.cost}。"
                f"针对用户提出的「{(user_content or '')[:60]}…」相关问题，"
                f"该模型回答更贴合{label}业务，推荐作为首选。"
            ),
            models=model_reports,
        )
    except Exception as exc:
        logger.exception("报告数据结构构建失败")
        raise ValueError(f"报告生成失败：{exc}") from exc

    return report


def build_report_intro_text(user_content: str, scenario: str, report: ReportDataSchema) -> str:
    """生成报告消息上方的介绍性总结（模板驱动，见 config/templates/report_intro.txt.j2）。"""
    return render_report_intro(user_content, scenario, report)


def report_to_markdown(report: ReportDataSchema) -> str:
    """导出 Markdown（模板驱动，见 config/templates/report.md.j2）。"""
    return render_report_markdown(report)


def _models_from_orm(records: list[ModelORM]) -> list[EvalModel]:
    models = [
        EvalModel(
            id=m.id,
            name=m.name,
            invoke=build_invoke_config_from_orm(m),
        )
        for m in records
    ]
    for em in models:
        print(
            f"[评测模型] {em.name} type={em.invoke.provider_type} "
            f"adapter={em.invoke.adapter} model={em.invoke.model} "
            f"has_key={bool(em.invoke.api_key)}"
        )
    return models


async def generate_evaluation_report_with_progress(
    task_id: str,
    conversation_id: str,
    user_content: str = "",
    *,
    model_records: list[ModelORM] | None = None,
    eval_models: list[EvalModel] | None = None,
) -> ReportDataSchema:
    """带进度更新的评测入口（进度仅写内存 progress_store，不触库）。"""
    question = (user_content or "").strip()
    print(f"[评测入口] 收到用户问题: {question}")
    logger.info("generate_evaluation_report_with_progress question=%s", question)

    if eval_models is None:
        if not model_records:
            raise ValueError("model_records 或 eval_models 必须提供其一")
        models = _models_from_orm(model_records)
    else:
        models = eval_models

    scenario = detect_scenario(question)
    print(f"[评测入口] 识别场景: {scenario}")
    estimated_cases = estimate_test_case_count(scenario)

    _update_progress(
        task_id,
        progress=5,
        current_step="生成用例",
        completed_cases=0,
        total_cases=estimated_cases,
    )

    invoke_for_cases = models[0].invoke if models else None

    _update_progress(
        task_id,
        progress=10,
        current_step="生成用例",
        completed_cases=0,
        total_cases=estimated_cases,
    )
    test_cases = await generate_test_cases(
        scenario, question, invoke_config=invoke_for_cases
    )
    _update_progress(
        task_id,
        progress=20,
        current_step="生成用例",
        completed_cases=len(test_cases),
        total_cases=len(test_cases),
    )

    print(
        f"[评测入口] 参与评测 {len(models)} 个模型: "
        f"{[(m.name, m.invoke.model) for m in models]}"
    )

    return await run_evaluation(
        test_cases,
        models,
        conversation_id,
        scenario,
        question,
        task_id=task_id,
    )


async def generate_evaluation_report(
    conversation_id: str,
    model_records: list[ModelORM],
    user_content: str = "",
) -> ReportDataSchema:
    """对外入口：根据用户问题生成测试用例并执行真实多模型评测。"""
    question = (user_content or "").strip()
    print(f"[评测入口] 收到用户问题: {question}")
    logger.info("generate_evaluation_report question=%s", question)

    scenario = detect_scenario(question)
    print(f"[评测入口] 识别场景: {scenario}")

    models = _models_from_orm(model_records)
    invoke_for_cases = models[0].invoke if models else None
    test_cases = await generate_test_cases(
        scenario, question, invoke_config=invoke_for_cases
    )
    print(
        f"[评测入口] 参与评测 {len(models)} 个模型: "
        f"{[(m.name, m.invoke.model) for m in models]}"
    )

    return await run_evaluation(
        test_cases,
        models,
        conversation_id,
        scenario,
        question,
    )


@dataclass
class ClientEvalCellInput:
    model_id: str
    test_case_id: str
    output: str
    time: str
    status: str
    elapsed_seconds: float
    prompt_tokens: int
    completion_tokens: int


def build_report_from_client_results(
    *,
    conversation_id: str,
    user_content: str,
    scenario: str,
    test_cases: list[TestCase],
    models_meta: list[dict[str, str]],
    cells: list[ClientEvalCellInput],
    wall_duration_seconds: int = 0,
) -> ReportDataSchema:
    """根据浏览器提交的评测结果生成报告（服务端不调用模型）。"""
    meta_by_id = {m["id"]: m for m in models_meta}
    tc_by_id = {tc.id: tc for tc in test_cases}

    by_model: dict[str, list[ClientEvalCellInput]] = {m["id"]: [] for m in models_meta}
    for cell in cells:
        if cell.model_id in by_model:
            by_model[cell.model_id].append(cell)

    model_reports: list[ModelReportSchema] = []
    scores: list[tuple[float, ModelReportSchema]] = []

    for meta in models_meta:
        model_id = meta["id"]
        model_name = meta.get("name", model_id)
        api_model = meta.get("api_model", "default")
        model_cells = sorted(by_model.get(model_id, []), key=lambda c: c.test_case_id)

        if not model_cells:
            model_cells = [
                ClientEvalCellInput(
                    model_id=model_id,
                    test_case_id=tc.id,
                    output="【调用失败】该模型未返回评测数据",
                    time="N/A",
                    status="failure",
                    elapsed_seconds=0.0,
                    prompt_tokens=0,
                    completion_tokens=0,
                )
                for tc in test_cases
            ]

        results: list[TestCaseResultSchema] = []
        successes = 0
        total_elapsed = 0.0
        total_cost = 0.0

        for cell in model_cells:
            tc = tc_by_id.get(cell.test_case_id)
            success = cell.status == "success"
            if success:
                successes += 1
            total_elapsed += cell.elapsed_seconds
            total_cost += _estimate_cost_usd(
                api_model, cell.prompt_tokens, cell.completion_tokens
            )
            results.append(
                TestCaseResultSchema(
                    id=f"{model_id}-{cell.test_case_id}",
                    input=tc.input if tc else "",
                    output=cell.output,
                    time=cell.time,
                    status="success" if success else "failure",
                )
            )

        total = len(model_cells)
        success_rate = successes / total if total else 0.0
        avg_seconds = total_elapsed / total if total else 0.0
        pros, cons = _build_pros_cons(
            success_rate, avg_seconds, total - successes, scenario
        )

        report_model = ModelReportSchema(
            id=model_id,
            name=model_name,
            success_rate=f"{round(success_rate * 100, 1)}%",
            avg_time=_format_duration(avg_seconds),
            cost=_format_cost(total_cost),
            pros=pros,
            cons=cons,
            test_cases=results,
        )
        model_reports.append(report_model)
        scores.append((_model_score(success_rate, avg_seconds, total_cost), report_model))

    scores.sort(key=lambda x: x[0], reverse=True)
    if not scores:
        raise ValueError("所有模型评测均无有效结果，无法生成报告")
    best = scores[0][1]
    label = SCENARIO_LABELS.get(scenario, "业务")
    total_seconds = wall_duration_seconds or 1
    duration_label = (
        f"{total_seconds}秒"
        if total_seconds <= 60
        else f"约 {total_seconds // 60} 分 {total_seconds % 60} 秒"
    )

    return ReportDataSchema(
        id=new_id("report-"),
        conversation_id=conversation_id,
        generated_at=format_datetime(),
        test_case_count=len(test_cases),
        test_case_summary=summarize_categories(test_cases, scenario),
        total_duration=duration_label,
        total_duration_seconds=total_seconds,
        best_model=best.name,
        recommendation_reason=(
            f"{best.name} 在{label}场景 AI 评测中综合表现最佳：成功率 {best.success_rate}，"
            f"平均响应 {best.avg_time}，估算成本 {best.cost}。"
            f"针对用户提出的「{(user_content or '')[:60]}…」相关问题，"
            f"该模型回答更贴合{label}业务，推荐作为首选。"
        ),
        models=model_reports,
    )


def _mock_output_for_case(test_case: TestCase, scenario: str) -> str:
    label = SCENARIO_LABELS.get(scenario, "业务")
    return (
        f"（演示数据）针对{label}场景问题「{test_case.input[:40]}…」的模拟回答。"
        "配置 OPENAI_API_KEY 后将展示真实模型评测结果。"
    )


def generate_mock_report(
    conversation_id: str,
    model_names: list[str] | None = None,
    user_content: str = "",
) -> ReportDataSchema:
    """无 API Key 或评测失败时的降级报告（仍基于用户场景，非植物硬编码）。"""
    import random

    question = (user_content or "").strip()
    print(f"[Mock报告] 用户问题: {question}")
    scenario = detect_scenario(question)
    test_cases = generate_test_cases_sync(scenario, question)
    label = SCENARIO_LABELS.get(scenario, "业务")

    names = model_names or ["GPT-4o", "Claude 3.5 Sonnet", "GPT-3.5 Turbo"]
    model_reports: list[ModelReportSchema] = []

    for i, name in enumerate(names):
        rate = round(70 + random.random() * 25, 1)
        success_rate = rate / 100.0
        pros, cons = _build_pros_cons(success_rate, 2.0 + i * 0.3, 0, scenario)
        model_reports.append(
            ModelReportSchema(
                id=f"model_{i}",
                name=name,
                success_rate=f"{rate}%",
                avg_time=f"{2.0 + i * 0.4:.1f}s",
                cost=f"${0.04 + i * 0.03:.2f}",
                pros=pros,
                cons=cons,
                test_cases=[
                    TestCaseResultSchema(
                        id=f"model_{i}-{tc.id}",
                        input=tc.input,
                        output=_mock_output_for_case(tc, scenario),
                        time=f"{2.0 + j * 0.2:.1f}s",
                        status="success" if j < int(len(test_cases) * rate / 100) else "failure",
                    )
                    for j, tc in enumerate(test_cases)
                ],
            )
        )

    def parse_rate(m: ModelReportSchema) -> float:
        match = re.search(r"[\d.]+", m.success_rate)
        return float(match.group()) if match else 0.0

    best = max(model_reports, key=parse_rate)

    return ReportDataSchema(
        id=new_id("report-"),
        conversation_id=conversation_id,
        generated_at=format_datetime(),
        test_case_count=len(test_cases),
        test_case_summary=summarize_categories(test_cases, scenario),
        total_duration="约 45 秒",
        total_duration_seconds=45,
        best_model=best.name,
        recommendation_reason=(
            f"{best.name} 在本次{label}场景评测中综合表现最优（演示数据）。"
            f"评测围绕用户问题「{question[:80]}」生成，请配置 API 后查看真实结果。"
        ),
        models=model_reports,
    )


