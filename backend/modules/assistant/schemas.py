import uuid
from datetime import date, datetime

from pydantic import BaseModel, Field


class AssistantMessageIn(BaseModel):
    role: str  # "user" | "assistant"
    content: str


class AskRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=2000)
    period_end: date | None = None  # active period for context; tools default to it
    history: list[AssistantMessageIn] | None = None
    thread_id: uuid.UUID | None = None  # continue an existing conversation


class AskSource(BaseModel):
    tool: str
    input: dict


class AskLink(BaseModel):
    path: str
    label: str


class AskResponse(BaseModel):
    answer: str
    sources: list[AskSource]
    thread_id: uuid.UUID | None = None
    # Assistant-drafted journal entries (also persisted as ProposedEntry rows in
    # the Adjustments queue) + deep-link buttons. Phase 2.
    drafts: list[dict] = []
    links: list[AskLink] = []
    # One-click "prepare" actions (run recon/flux agentic, propose-only). Phase 3.
    actions: list[dict] = []
    # Charts rendered under the answer (bar/pie/line). Phase 3.
    charts: list[dict] = []


class AssistantExportRequest(BaseModel):
    """Export one Copilot answer to a file. The frontend sends the answer the user
    is looking at (text + any charts) — the endpoint just formats it, no AI/DB read
    of the answer itself."""
    format: str = Field(..., pattern="^(pdf|xlsx)$")
    question: str = Field("", max_length=2000)
    answer: str = Field("", max_length=40000)
    charts: list[dict] = []


class ThreadSummary(BaseModel):
    id: uuid.UUID
    title: str
    updated_at: datetime


class ThreadMessage(BaseModel):
    role: str
    content: str
    sources: list[dict] | None = None
    created_at: datetime
