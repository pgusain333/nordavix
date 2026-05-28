# Import all models here so that Base.metadata is fully populated
# before Alembic generates or runs migrations.
from models.account import Account
from models.account_review_status import AccountReviewStatus
from models.ai_usage import AIUsage
from models.audit_log import AuditLog
from models.closed_period import ClosedPeriod
from models.feedback import Feedback
from models.missed_accrual_candidate import MissedAccrualCandidate
from models.narrative import Narrative
from models.period_sync import PeriodSync
from models.prepaid_candidate import PrepaidCandidate
from models.qbo_connection import QboConnection
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

__all__ = [
    "Account",
    "AccountReviewStatus",
    "AIUsage",
    "AuditLog",
    "ClosedPeriod",
    "Feedback",
    "MissedAccrualCandidate",
    "Narrative",
    "PeriodSync",
    "PrepaidCandidate",
    "QboConnection",
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
]
