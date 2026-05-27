from functools import lru_cache
from pathlib import Path

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

_BACKEND_ROOT = Path(__file__).resolve().parent.parent
_DEFAULT_DB_PATH = (_BACKEND_ROOT / "aipm.db").as_posix()


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # 兼容旧变量名（等同 DEEPSEEK_API_KEY）
    openai_api_key: str = ""
    openai_base_url: str = "https://api.deepseek.com/v1"
    openai_default_model: str = "deepseek-v4-flash"
    openai_chat_max_tokens: int = 4096

    # DeepSeek（OpenAI 兼容）
    deepseek_api_key: str = "sk-b55b7bd4a5e64759a9d489ca72d85db3"
    deepseek_base_url: str = "https://api.deepseek.com"
    deepseek_model: str = "deepseek-v4-flash"

    # 阿里云 Qwen / DashScope（默认走原生 API；compatible-mode URL 时走 OpenAI 兼容）
    qwen_api_key: str = "sk-f4236e3c4c964c96955349c11421a712"
    qwen_base_url: str = "https://dashscope.aliyuncs.com/api/v1"
    qwen_model: str = "qwen-plus"

    # 数据库配置（固定相对 aipm-backend 目录，避免 CWD 不同产生多个库文件）
    database_url: str = f"sqlite+aiosqlite:///{_DEFAULT_DB_PATH}"

    # CORS 配置
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"

    # 加密配置
    encryption_key: str = ""

    # 讯飞 Spark HTTP APIPassword（可选；浏览器 Key 优先，仅用于服务端调试）
    spark_api_password: str = "gceVBqxlfhySoyCFXjdV:aXGDHqIRzcWJYjfbsFkX"

    # 评测性能（PRD：3 用例 × 多模型总时长目标 ~30s）
    eval_api_timeout_seconds: float = 60.0
    eval_max_concurrent_requests: int = 9
    eval_max_tokens_per_case: int = 512
    eval_use_llm_test_cases: bool = False
    eval_case_gen_timeout_seconds: float = 10.0
    eval_persist_timeout_seconds: float = 12.0
    eval_total_budget_seconds: float = 120.0

    @model_validator(mode="after")
    def _sync_legacy_openai_env(self) -> "Settings":
        """兼容旧 .env 仅配置 OPENAI_API_KEY 的情况。"""
        if not self.deepseek_api_key and self.openai_api_key:
            self.deepseek_api_key = self.openai_api_key
        if not self.deepseek_base_url and self.openai_base_url:
            self.deepseek_base_url = self.openai_base_url
        if not self.deepseek_model and self.openai_default_model:
            self.deepseek_model = self.openai_default_model
        return self

    @model_validator(mode="after")
    def _normalize_database_url(self) -> "Settings":
        """将相对路径 SQLite 文件固定到 aipm-backend 目录，避免 CWD 不同产生多个库。"""
        prefix = "sqlite+aiosqlite:///"
        url = self.database_url
        if not url.startswith(prefix):
            return self
        path_part = url[len(prefix) :]
        if Path(path_part).is_absolute():
            return self
        abs_path = (_BACKEND_ROOT / path_part.removeprefix("./")).resolve()
        self.database_url = f"{prefix}{abs_path.as_posix()}"
        return self

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()