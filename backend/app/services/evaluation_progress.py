"""评测任务进度内存存储（key=task_id）。"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Any, Literal

EvaluationStatus = Literal["running", "completed", "failed"]
PersistStatus = Literal["none", "pending", "saved", "failed"]


@dataclass
class EvaluationProgressState:
    task_id: str
    conversation_id: str
    progress: int = 0
    current_step: str = "准备中"
    completed_cases: int = 0
    total_cases: int = 0
    estimated_remaining_seconds: int = 0
    estimated_total_seconds: int = 45
    model_count: int = 0
    status: EvaluationStatus = "running"
    persist_status: PersistStatus = "none"
    persist_error: str | None = None
    error: str | None = None
    report_data: dict[str, Any] | None = None
    message: dict[str, Any] | None = None
    user_question: str = ""
    scenario: str = ""
    model_ids: list[str] = field(default_factory=list)
    client_eval_ready: bool = False
    test_cases: list[dict[str, Any]] = field(default_factory=list)
    models_meta: list[dict[str, Any]] = field(default_factory=list)
    system_prompt: str = ""
    started_at: float = field(default_factory=time.perf_counter)

    def to_dict(self) -> dict[str, Any]:
        payload = {
            "task_id": self.task_id,
            "conversation_id": self.conversation_id,
            "progress": max(0, min(100, int(self.progress))),
            "current_step": self.current_step,
            "completed_cases": self.completed_cases,
            "total_cases": self.total_cases,
            "estimated_remaining_seconds": max(0, int(self.estimated_remaining_seconds)),
            "estimated_total_seconds": max(1, int(self.estimated_total_seconds)),
            "model_count": max(0, int(self.model_count)),
            "status": self.status,
            "persist_status": self.persist_status,
            "persist_error": self.persist_error,
            "error": self.error,
            "report_data": self.report_data,
            "message": self.message,
            "client_eval_ready": self.client_eval_ready,
        }
        if self.client_eval_ready:
            payload["test_cases"] = self.test_cases
            payload["models_meta"] = self.models_meta
            payload["system_prompt"] = self.system_prompt
        return payload

    def _refresh_eta(self) -> None:
        if self.status == "completed":
            self.estimated_remaining_seconds = 0
            return
        elapsed = time.perf_counter() - self.started_at
        if self.progress >= 100:
            self.estimated_remaining_seconds = 0
            return
        if self.progress <= 0:
            self.estimated_remaining_seconds = 60
            return
        effective_progress = max(self.progress, 3)
        estimated_total = elapsed / (effective_progress / 100.0)
        remaining = estimated_total - elapsed
        if remaining < 1:
            remaining = max(1, int(60 * (100 - self.progress) / 100))
        self.estimated_remaining_seconds = int(max(1, remaining))


class EvaluationProgressStore:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._tasks: dict[str, EvaluationProgressState] = {}

    def create(
        self,
        task_id: str,
        conversation_id: str,
        *,
        estimated_total_seconds: int = 45,
        model_count: int = 0,
        user_question: str = "",
        scenario: str = "",
        model_ids: list[str] | None = None,
    ) -> EvaluationProgressState:
        with self._lock:
            state = EvaluationProgressState(task_id=task_id, conversation_id=conversation_id)
            state.estimated_remaining_seconds = estimated_total_seconds
            state.estimated_total_seconds = estimated_total_seconds
            state.model_count = model_count
            state.user_question = user_question
            state.scenario = scenario
            state.model_ids = list(model_ids or [])
            self._tasks[task_id] = state
            return state

    def get(self, task_id: str) -> EvaluationProgressState | None:
        with self._lock:
            return self._tasks.get(task_id)

    def update(
        self,
        task_id: str,
        *,
        progress: int | None = None,
        current_step: str | None = None,
        completed_cases: int | None = None,
        total_cases: int | None = None,
        estimated_total_seconds: int | None = None,
        model_count: int | None = None,
        status: EvaluationStatus | None = None,
        error: str | None = None,
    ) -> None:
        with self._lock:
            state = self._tasks.get(task_id)
            if not state:
                return
            if progress is not None:
                state.progress = progress
            if current_step is not None:
                state.current_step = current_step
            if completed_cases is not None:
                state.completed_cases = completed_cases
            if total_cases is not None:
                state.total_cases = total_cases
            if estimated_total_seconds is not None:
                state.estimated_total_seconds = estimated_total_seconds
            if model_count is not None:
                state.model_count = model_count
            if status is not None:
                state.status = status
            if error is not None:
                state.error = error
            state._refresh_eta()

    def complete(
        self,
        task_id: str,
        *,
        report_data: dict[str, Any],
        message: dict[str, Any],
        persist_status: PersistStatus = "pending",
    ) -> None:
        with self._lock:
            state = self._tasks.get(task_id)
            if not state:
                return
            state.progress = 100
            state.current_step = "评测已完成"
            state.status = "completed"
            state.estimated_remaining_seconds = 0
            state.report_data = report_data
            state.message = message
            state.persist_status = persist_status
            state.persist_error = None

    def mark_persist_saved(self, task_id: str) -> None:
        with self._lock:
            state = self._tasks.get(task_id)
            if not state:
                return
            state.persist_status = "saved"
            state.persist_error = None

    def mark_persist_failed(self, task_id: str, error: str) -> None:
        with self._lock:
            state = self._tasks.get(task_id)
            if not state:
                return
            state.persist_status = "failed"
            state.persist_error = error[:500]

    def fail(self, task_id: str, error: str) -> None:
        with self._lock:
            state = self._tasks.get(task_id)
            if not state:
                return
            state.status = "failed"
            state.error = error
            state.current_step = "失败"
            state.estimated_remaining_seconds = 0

    def mark_client_eval_ready(
        self,
        task_id: str,
        *,
        test_cases: list[dict[str, Any]],
        models_meta: list[dict[str, Any]],
        system_prompt: str,
    ) -> None:
        with self._lock:
            state = self._tasks.get(task_id)
            if not state:
                return
            state.client_eval_ready = True
            state.test_cases = test_cases
            state.models_meta = models_meta
            state.system_prompt = system_prompt
            state.progress = max(state.progress, 20)
            state.current_step = "浏览器评测"
            state.total_cases = len(test_cases)
            state._refresh_eta()


progress_store = EvaluationProgressStore()
