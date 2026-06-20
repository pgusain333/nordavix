# Import all models here so that Base.metadata is fully populated
# before Alembic generates or runs migrations.
from models.account import Account
from models.account_review_status import AccountReviewStatus
from models.advisory import KpiTarget, TrackedRecommendation
from models.ai_usage import AIUsage
from models.assistant_conversation import AssistantMessage, AssistantThread
from models.audit_log import AuditLog
from models.autopilot import AutopilotConfig, AutopilotRun
from models.bank_statement import BankStatement
from models.client_memory import ClientMemoryFact, ClientMemorySignal
from models.close_review import CloseReview, CloseReviewFinding
from models.close_step import CloseStepInstance, CloseTemplateStep
from models.closed_period import ClosedPeriod
from models.comment import Comment
from models.evidence_request import EvidenceRequest
from models.feedback import Feedback
from models.gl_accuracy_finding import GlAccuracyFinding
from models.insights_snapshot import InsightsSnapshot
from models.intercompany_account import IntercompanyAccount
from models.intercompany_pair import IntercompanyPair
from models.missed_accrual_candidate import MissedAccrualCandidate
from models.narrative import Narrative
from models.notification import Notification
from models.period_sync import PeriodSync
from models.prepaid_candidate import PrepaidCandidate
from models.proposed_entry import ProposedEntry
from models.qbo_connection import QboConnection
from models.reengagement_enrollment import ReengagementEnrollment
from models.relationship import Relationship
from models.schedule import (
    ScheduleAccrual,
    ScheduleFixedAsset,
    ScheduleLease,
    ScheduleLoan,
    SchedulePrepaid,
    ScheduleSnapshot,
)
from models.subledger_evidence import SubledgerEvidence
from models.tenant import Tenant
from models.trial_balance import TrialBalance
from models.user import User
from models.variance import Variance
from models.workpaper_evidence import WorkpaperEvidence

__all__ = [
    "AutopilotConfig",
    "AutopilotRun",
    "Account",
    "AccountReviewStatus",
    "AIUsage",
    "AssistantMessage",
    "AssistantThread",
    "KpiTarget",
    "TrackedRecommendation",
    "AuditLog",
    "BankStatement",
    "ClientMemoryFact",
    "ClientMemorySignal",
    "CloseReview",
    "CloseReviewFinding",
    "CloseStepInstance",
    "CloseTemplateStep",
    "ClosedPeriod",
    "Comment",
    "Feedback",
    "GlAccuracyFinding",
    "InsightsSnapshot",
    "IntercompanyAccount",
    "IntercompanyPair",
    "MissedAccrualCandidate",
    "Narrative",
    "Notification",
    "PeriodSync",
    "PrepaidCandidate",
    "EvidenceRequest",
    "ProposedEntry",
    "QboConnection",
    "ReengagementEnrollment",
    "Relationship",
    "ScheduleAccrual",
    "ScheduleFixedAsset",
    "ScheduleLease",
    "ScheduleLoan",
    "SchedulePrepaid",
    "ScheduleSnapshot",
    "SubledgerEvidence",
    "Tenant",
    "TrialBalance",
    "User",
    "Variance",
    "WorkpaperEvidence",
]
