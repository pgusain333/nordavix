from datetime import date

from pydantic import BaseModel, Field


class AssistantMessage(BaseModel):
    role: str  # "user" | "assistant"
    content: str


class AskRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=2000)
    period_end: date | None = None  # active period for context; tools default to it
    history: list[AssistantMessage] | None = None


class AskSource(BaseModel):
    tool: str
    input: dict


class AskResponse(BaseModel):
    answer: str
    sources: list[AskSource]
