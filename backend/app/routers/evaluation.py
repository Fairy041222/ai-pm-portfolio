import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.schemas import EvaluationProgressSchema
from app.services.evaluation_persist import persist_report_from_task
from app.services.evaluation_progress import progress_store
from app.services.evaluation_runner import complete_client_evaluation
from app.services.report_service import ClientEvalCellInput

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/evaluation", tags=["evaluation"])


class PersistReportResponse(BaseModel):
    ok: bool = True
    report_id: str
    conversation_id: str
    already_saved: bool = False


class EvalCellSubmitSchema(BaseModel):
    model_id: str = Field(alias="modelId")
    test_case_id: str = Field(alias="testCaseId")
    output: str
    time: str
    status: str
    elapsed_seconds: float = Field(default=0, alias="elapsedSeconds")
    prompt_tokens: int = Field(default=0, alias="promptTokens")
    completion_tokens: int = Field(default=0, alias="completionTokens")

    model_config = {"populate_by_name": True}


class SubmitEvalResultsRequest(BaseModel):
    conversation_id: str = Field(alias="conversationId")
    cells: list[EvalCellSubmitSchema]
    wall_duration_seconds: int = Field(default=0, alias="wallDurationSeconds")

    model_config = {"populate_by_name": True}


class PatchEvalProgressRequest(BaseModel):
    progress: int | None = None
    current_step: str | None = Field(default=None, alias="currentStep")
    completed_cases: int | None = Field(default=None, alias="completedCases")
    total_cases: int | None = Field(default=None, alias="totalCases")

    model_config = {"populate_by_name": True}


@router.get("/progress/{task_id}", response_model=EvaluationProgressSchema)
async def get_evaluation_progress(task_id: str) -> EvaluationProgressSchema:
    state = progress_store.get(task_id)
    if not state:
        raise HTTPException(status_code=404, detail="评测任务不存在或已过期")
    try:
        return EvaluationProgressSchema.model_validate(state.to_dict())
    except Exception as exc:
        logger.exception("进度序列化失败 task_id=%s", task_id)
        raise HTTPException(status_code=500, detail=f"进度数据异常：{exc}") from exc


@router.patch("/tasks/{task_id}/progress", response_model=EvaluationProgressSchema)
async def patch_evaluation_progress(
    task_id: str,
    body: PatchEvalProgressRequest,
) -> EvaluationProgressSchema:
    state = progress_store.get(task_id)
    if not state:
        raise HTTPException(status_code=404, detail="评测任务不存在或已过期")
    progress_store.update(
        task_id,
        progress=body.progress,
        current_step=body.current_step,
        completed_cases=body.completed_cases,
        total_cases=body.total_cases,
    )
    updated = progress_store.get(task_id)
    return EvaluationProgressSchema.model_validate(updated.to_dict())  # type: ignore[union-attr]


@router.post("/tasks/{task_id}/submit-results", response_model=EvaluationProgressSchema)
async def submit_evaluation_results(
    task_id: str,
    body: SubmitEvalResultsRequest,
) -> EvaluationProgressSchema:
    state = progress_store.get(task_id)
    if not state:
        raise HTTPException(status_code=404, detail="评测任务不存在或已过期")
    if state.conversation_id != body.conversation_id:
        raise HTTPException(status_code=400, detail="conversationId 与任务不匹配")

    cells = [
        ClientEvalCellInput(
            model_id=c.model_id,
            test_case_id=c.test_case_id,
            output=c.output,
            time=c.time,
            status=c.status,
            elapsed_seconds=c.elapsed_seconds,
            prompt_tokens=c.prompt_tokens,
            completion_tokens=c.completion_tokens,
        )
        for c in body.cells
    ]
    try:
        await complete_client_evaluation(
            task_id=task_id,
            cells=cells,
            wall_duration_seconds=body.wall_duration_seconds,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("submit-results failed task_id=%s", task_id)
        progress_store.fail(task_id, str(exc))
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    updated = progress_store.get(task_id)
    if not updated:
        raise HTTPException(status_code=404, detail="评测任务不存在")
    return EvaluationProgressSchema.model_validate(updated.to_dict())


@router.post("/tasks/{task_id}/persist-report", response_model=PersistReportResponse)
async def persist_evaluation_report(task_id: str) -> PersistReportResponse:
    """重新将内存中的评测报告写入数据库（无需重新评测）。"""
    try:
        result = await persist_report_from_task(task_id)
        return PersistReportResponse(**result)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
