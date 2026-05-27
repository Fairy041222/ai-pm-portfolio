from dataclasses import dataclass


@dataclass
class ChatResult:
    content: str
    success: bool
    prompt_tokens: int = 0
    completion_tokens: int = 0
    error: str | None = None
