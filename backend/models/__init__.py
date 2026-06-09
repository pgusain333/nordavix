# Import all models here so that Base.metadata is fully populated
# before Alembic generates or runs migrations.
from models.account import Account
from models.account_review_status import AccountReviewStatus
from models.ai_usage import AIUsage
from models.audit_log import AuditLog
from models.bank_statement import BankStatement
from models.closed_period import ClosedPeriod
from models.comment import Comment
from models.feedback import Feedback
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
    "BankStatement",
    "ClosedPeriod",
    "Comment",
    "Feedback",
    "InsightsSnapshot",
    "IntercompanyAccount",
    "IntercompanyPair",
    "MissedAccrualCandidate",
    "Narrative",
    "Notification",
    "PeriodSync",
    "PrepaidCandidate",
    "ProposedEntry",
    "QboConnection",
    "ReengagementEnrollment",
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
