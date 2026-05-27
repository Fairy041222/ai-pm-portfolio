"""后台准备评测任务（用例生成在服务端，模型调用在浏览器）。"""

from __future__ import annotations

import logging
from datetime import datetime

from app.database import AsyncSessionLocal
from app.schemas import MessageSchema, ReportDataSchema
from app.services.conversation_service import get_conversation
from app.services.endpoint_inference import infer_vendor_from_text
from app.services.evaluation_persist import schedule_persist_report
from app.services.evaluation_progress import progress_store
from app.services.model_resolver import resolve_model_ids
from app.services.report_service import (
    ClientEvalCellInput,
    build_report_from_client_results,
    build_report_intro_text,
)
from app.services.test_case_generator import (
    TestCase,
    detect_scenario,
    generate_test_cases,
    get_system_prompt,
)
from app.utils import format_time, new_id

logger = logging.getLogger(__name__)


async def _load_models_meta(
    conversation_id: str,
    model_ids: list[str],
    task_id: str,
) -> list[dict[str, str]] | None:
    async with AsyncSessionLocal() as db:
        conv = await get_conversation(db, conversation_id)
        if not conv:
            progress_store.fail(task_id, "对话不存在")
            return None

        _, model_records, _, _ = await resolve_model_ids(
            db,
            model_ids,
            is_report_mode=True,
        )
        if len(model_records) < 2:
            progress_store.fail(task_id, "至少需要 2 个模型参与评测")
            return None

        return [
            {
                "id": m.id,
                "name": m.name,
                "api_endpoint": m.api_endpoint or "",
                "api_model": m.model_identifier or "",
                "vendor": infer_vendor_from_text(m.api_endpoint or "", m.name or ""),
            }
            for m in model_records
        ]


def _complete_evaluation_in_memory(
    *,
    task_id: str,
    conversation_id: str,
    user_question: str,
    scenario: str,
    report: ReportDataSchema,
) -> None:
    report_payload = report.model_dump(by_alias=True)
    intro_text = build_report_intro_text(user_question, scenario, report)
    msg = MessageSchema(
        id=new_id("msg_"),
        role="assistant",
        content=intro_text,
        timestamp=format_time(datetime.utcnow()),
        type="report",
        report_data=ReportDataSchema.model_validate(report_payload),
    )
    progress_store.complete(
        task_id,
        report_data=report_payload,
        message=msg.model_dump(by_alias=True),
        persist_status="pending",
    )
    logger.info("评测内存完成 task_id=%s report_id=%s", task_id, report.id)


async def run_evaluation_background(
    *,
    task_id: str,
    conversation_id: str,
    user_question: str,
    model_ids: list[str],
) -> None:
    scenario = detect_scenario(user_question)
    try:
        models_meta = await _load_models_meta(conversation_id, model_ids, task_id)
        if not models_meta:
            return

        progress_store.update(
            task_id,
            progress=10,
            current_step="生成用例",
            completed_cases=0,
        )
        test_cases = await generate_test_cases(
            scenario, user_question, invoke_config=None
        )
        system_prompt = get_system_prompt(scenario, user_question)

        progress_store.update(
            task_id,
            progress=15,
            current_step="生成用例",
            completed_cases=len(test_cases),
            total_cases=len(test_cases),
        )
        progress_store.mark_client_eval_ready(
            task_id,
            test_cases=[
                {"id": tc.id, "input": tc.input, "category": tc.category}
                for tc in test_cases
            ],
            models_meta=models_meta,
            system_prompt=system_prompt,
        )
        logger.info(
            "客户端评测就绪 task_id=%s cases=%s models=%s",
            task_id,
            len(test_cases),
            len(models_meta),
        )
    except Exception as exc:
        logger.exception("Evaluation prepare failed task_id=%s", task_id)
        progress_store.fail(task_id, str(exc))


async def complete_client_evaluation(
    *,
    task_id: str,
    cells: list[ClientEvalCellInput],
    wall_duration_seconds: int = 0,
) -> None:
    state = progress_store.get(task_id)
    if not state:
        raise ValueError("评测任务不存在或已过期")
    if state.status == "completed":
        return

    test_cases = [
        TestCase(
            id=str(item.get("id", "")),
            input=str(item.get("input", "")),
            category=str(item.get("category", "normal")),
        )
        for item in state.test_cases
    ]
    if not test_cases:
        raise ValueError("测试用例缺失，无法生成报告")

    report = build_report_from_client_results(
        conversation_id=state.conversation_id,
        user_content=state.user_question,
        scenario=state.scenario or detect_scenario(state.user_question),
        test_cases=test_cases,
        models_meta=state.models_meta,
        cells=cells,
        wall_duration_seconds=wall_duration_seconds,
    )
    _complete_evaluation_in_memory(
        task_id=task_id,
        conversation_id=state.conversation_id,
        user_question=state.user_question,
        scenario=state.scenario or detect_scenario(state.user_question),
        report=report,
    )
    schedule_persist_report(task_id)
