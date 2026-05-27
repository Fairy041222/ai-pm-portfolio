"""NFR-M2：报告模板渲染（与 report_service 业务逻辑解耦）。"""

from __future__ import annotations

import logging
from functools import lru_cache
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, select_autoescape

from app.schemas import ReportDataSchema
from app.services.test_case_generator import SCENARIO_LABELS

logger = logging.getLogger(__name__)

_TEMPLATES_DIR = Path(__file__).resolve().parents[2] / "config" / "templates"


@lru_cache(maxsize=1)
def _jinja_env() -> Environment:
    return Environment(
        loader=FileSystemLoader(str(_TEMPLATES_DIR)),
        autoescape=select_autoescape(default_for_string=False),
        trim_blocks=True,
        lstrip_blocks=True,
    )


def render_report_markdown(report: ReportDataSchema) -> str:
    template = _jinja_env().get_template("report.md.j2")
    payload = report.model_dump(by_alias=False)
    payload["report_title"] = "大模型性能对比报告"
    for model in payload.get("models") or []:
        for tc in model.get("test_cases") or []:
            if tc.get("output") is None:
                tc["output"] = ""
    rendered = template.render(**payload)
    logger.info("[ReportRenderer] 已渲染 Markdown 模板 report_id=%s", report.id)
    return rendered.strip() + "\n"


def render_report_intro(
    user_content: str,
    scenario: str,
    report: ReportDataSchema,
) -> str:
    template = _jinja_env().get_template("report_intro.txt.j2")
    label = SCENARIO_LABELS.get(scenario, "业务")
    model_names = "、".join(m.name for m in report.models)
    question = (user_content or "").strip()
    if question and len(question) > 100:
        question_display = f"{question[:100]}…"
    else:
        question_display = question

    if question_display and not _is_report_trigger(question_display):
        # 带用户问题的 intro 仍用简化模板变量
        return (
            f"好的，我已根据您的问题完成{label}场景的需求梳理与多模型对比评测。\n\n"
            f"您关注的内容：「{question_display}」\n\n"
            f"本次共执行 {report.test_case_summary or report.test_case_count} 个测试用例，"
            f"对比了 {len(report.models)} 个模型（{model_names}）。"
            f"综合表现最佳的是 {report.best_model}。\n"
            f"{report.recommendation_reason}\n\n"
            f"请点击下方报告查看各模型详细表现与用例结果。"
        )

    rendered = template.render(
        scenario_label=label,
        test_case_summary=report.test_case_summary or f"{report.test_case_count} 个测试用例",
        model_names=model_names,
        best_model=report.best_model,
        recommendation_reason=report.recommendation_reason,
    )
    return rendered.strip()


def _is_report_trigger(text: str) -> bool:
    from app.utils import is_report_trigger_content

    return is_report_trigger_content(text)
