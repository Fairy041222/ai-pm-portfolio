from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


def to_camel(string: str) -> str:
    parts = string.split("_")
    return parts[0] + "".join(word.capitalize() for word in parts[1:])


class CamelModel(BaseModel):
    model_config = ConfigDict(
        populate_by_name=True,
        alias_generator=to_camel,
        serialize_by_alias=True,
    )


# --- Shared types (align with frontend types/index.ts) ---


class TestCaseResultSchema(CamelModel):
    id: str
    input: str
    output: str
    time: str
    status: Literal["success", "failure"]


class ModelConItemSchema(CamelModel):
    text: str
    level: Literal["error", "warning"]


class ModelReportSchema(CamelModel):
    id: str
    name: str
    success_rate: str
    avg_time: str
    cost: str
    pros: list[str]
    cons: list[ModelConItemSchema]
    test_cases: list[TestCaseResultSchema]


class ReportDataSchema(CamelModel):
    id: str
    conversation_id: str
    generated_at: str
    test_case_count: int
    test_case_summary: str
    total_duration: str
    total_duration_seconds: int
    best_model: str
    recommendation_reason: str
    models: list[ModelReportSchema]


class MessageSchema(CamelModel):
    id: str
    role: Literal["user", "assistant"]
    content: str
    timestamp: str
    type: Literal["text", "report"] | None = "text"
    report_data: ReportDataSchema | None = None
    used_model_name: str | None = None
    used_default_model: bool | None = None


class ConversationSchema(CamelModel):
    id: str
    title: str
    date: str
    recommended_model: str
    messages: list[MessageSchema] = []
    related_report_id: str | None = None


class ModelSchema(CamelModel):
    id: str
    name: str
    api_endpoint: str = ""
    api_model: str = Field(
        default="",
        description="发往厂商 API 的 model 参数，如 hy3-preview、lite、deepseek-chat",
    )
    has_api_key: bool = False
    api_key_masked: str | None = None
    is_recommended: bool = False


class ModelPresetSchema(CamelModel):
    """config/models.yaml 中的预设模型条目。"""

    preset_id: str
    name: str
    enabled: bool = True
    vendor: str = "openai_compatible"
    api_endpoint: str = ""
    api_model: str = ""
    is_recommended: bool = False
    max_tokens: int = 1024
    temperature: float = 0.7
    timeout_seconds: int = 18
    description: str = ""
    adapter: str = "openai_compatible"


class ModelRegistrySchema(CamelModel):
    version: int = 1
    global_defaults: dict[str, Any] = Field(default_factory=dict)
    vendors: dict[str, Any] = Field(default_factory=dict)
    presets: list[ModelPresetSchema] = Field(default_factory=list)


# --- Request / Response ---


class DeleteConversationsRequest(BaseModel):
    ids: list[str]


class SendMessageRequest(BaseModel):
    """content 与 question 二选一或同时传；评测时优先使用 question。"""

    content: str = ""
    question: str | None = None
    model_ids: list[str] | None = None
    session_id: str | None = Field(
        default=None,
        description="浏览器会话 ID，用于安全限额与日志",
    )

    def resolved_question(self) -> str:
        return (self.question or self.content or "").strip()


class SecurityCheckQuotaResponse(CamelModel):
    allowed: bool
    current_count: int
    daily_limit: int
    remaining: int
    duplicate_blocked: bool = False
    message: str | None = None


class TextMessageResponse(CamelModel):
    type: Literal["text"] = "text"
    content: str
    message: MessageSchema
    used_model_name: str | None = None
    used_default_model: bool = False


class ReportMessageResponse(CamelModel):
    type: Literal["report"] = "report"
    report_data: ReportDataSchema
    message: MessageSchema


class ReportPendingResponse(CamelModel):
    type: Literal["report_pending"] = "report_pending"
    task_id: str
    message: MessageSchema


class EvaluationProgressSchema(CamelModel):
    task_id: str
    conversation_id: str
    progress: int = 0
    current_step: str = ""
    completed_cases: int = 0
    total_cases: int = 0
    estimated_remaining_seconds: int = 0
    estimated_total_seconds: int = 45
    model_count: int = 0
    status: Literal["running", "completed", "failed"] = "running"
    persist_status: Literal["none", "pending", "saved", "failed"] = "none"
    persist_error: str | None = None
    error: str | None = None
    report_data: ReportDataSchema | None = None
    message: MessageSchema | None = None
    client_eval_ready: bool = False
    test_cases: list[dict[str, str]] | None = None
    models_meta: list[dict[str, str]] | None = None
    system_prompt: str | None = None


class ClientModelMetaSchema(CamelModel):
    id: str
    name: str
    api_endpoint: str = ""
    api_model: str = ""
    vendor: str = "openai_compatible"


class ClientTextPendingResponse(CamelModel):
    type: Literal["client_text_pending"] = "client_text_pending"
    message: MessageSchema
    model: ClientModelMetaSchema
    used_default_model: bool = False


class SaveAssistantMessageRequest(BaseModel):
    content: str
    used_model_name: str | None = None
    used_default_model: bool = False


class CreateModelRequest(BaseModel):
    """名称、API 地址；api_model 可选。API Key 仅保存在浏览器，禁止上传服务端。"""

    name: str
    api_endpoint: str = Field(description="API base 或完整 chat URL")
    api: str | None = Field(default=None, description="兼容旧字段 api")
    api_key: str = Field(default="", description="已废弃：服务端拒绝接收")
    api_model: str = Field(default="", description="厂商 API model 参数，如 hy3-preview")


class UpdateModelRequest(BaseModel):
    name: str | None = None
    api_endpoint: str | None = None
    api: str | None = None
    api_model: str | None = Field(default=None, description="厂商 API model 参数")
    api_key: str | None = Field(
        default=None,
        description="已废弃：服务端拒绝接收",
    )
    clear_api_key: bool = False


class ExportReportRequest(BaseModel):
    format: Literal["markdown", "json"] = "markdown"


class ExportReportResponse(CamelModel):
    filename: str
    content: str
    content_type: str


class LlmProxyRequest(CamelModel):
    """浏览器经后端转发厂商 LLM 请求（Key 不落库）。"""

    api_key: str
    api_endpoint: str
    api_model: str = ""
    name: str = ""
    vendor: str = "spark"
    user_content: str
    system_prompt: str | None = None
    max_tokens: int = 1024
    timeout_seconds: int = 120


class LlmProxyResponse(CamelModel):
    content: str
    success: bool
    prompt_tokens: int = 0
    completion_tokens: int = 0
    error: str | None = None


class HealthResponse(BaseModel):
    status: str = "ok"
    database: str = "connected"
