"""The double-entry ledger — Phase 5 Slice 1. See docs/adr/0006 and
docs/specs/5-payments-wallet-ledger.md's "Account taxonomy" section;
field-level constraints here implement that decision, they don't
re-derive it.

Every FK uses `related_name="+"` — matches `apps.tapngo`'s and
`apps.seating`'s own convention: a reverse accessor on an RLS-protected
model would traverse the same `TenantScopedManager` that silently
empties for platform staff. Batched `.filter(...)` queries, not reverse
traversal, are used wherever a "lines of this entry" query is needed
(`apps.ledger.services`, `apps.ledger.views`).
"""

from decimal import Decimal

from django.db import models
from django.db.models import Q

from apps.businesses.models import Business
from apps.core.models import BaseModel
from apps.identity.models import User


class LedgerAccount(BaseModel):
    """One account in the double-entry ledger.

    `client` is overridden nullable here, unlike every other `BaseModel`
    subclass in this codebase — the single `integra_commission` row is
    platform-level and has no owning Client, matching
    `apps.identity.models.User`'s own nullable-`client` precedent for
    platform-staff rows (docs/adr/0003). The RLS `tenant_isolation`
    policy already treats a NULL `client_id` as invisible to ordinary
    tenants and visible only under
    `apps.core.rls.platform_staff_bypass()` — no policy SQL changes
    needed for this.

    Only ever constructed through the `get_or_create_*_account()`
    functions in `apps.ledger.services` — never
    `LedgerAccount.objects.create()`/`.all_objects.create()` directly
    anywhere else (grep-audited, see the spec's Test plan).
    """

    class AccountType(models.TextChoices):
        WALLET = "wallet", "Wallet"
        BUSINESS_CLEARING = "business_clearing", "Business clearing"
        INTEGRA_COMMISSION = "integra_commission", "Integra commission"
        PSP_SUSPENSE = "psp_suspense", "PSP suspense"
        REFUND_CONTRA = "refund_contra", "Refund / concession contra"

    # Overrides BaseModel.client (normally non-nullable) — django-stubs
    # generates the manager/queryset types from BaseModel's own
    # non-nullable declaration, so mypy sees this narrower-at-runtime
    # override as a type mismatch even though Django itself fully
    # supports overriding an abstract base class's field. See this
    # class's own docstring for why nullable is correct here.
    client = models.ForeignKey(  # type: ignore[assignment]
        "clients.Client", on_delete=models.PROTECT, related_name="+", null=True, blank=True
    )
    account_type = models.CharField(max_length=32, choices=AccountType.choices)
    business = models.ForeignKey(
        Business, on_delete=models.PROTECT, related_name="+", null=True, blank=True
    )
    passenger = models.ForeignKey(
        User, on_delete=models.PROTECT, related_name="+", null=True, blank=True
    )
    psp_provider = models.CharField(max_length=32, blank=True)
    # Never authoritative — SUM(JournalLine.amount) for this account is
    # always the real balance (docs/adr/0006). Written transactionally
    # alongside every apps.ledger.services.post_journal_entry() call.
    cached_balance = models.DecimalField(
        max_digits=10, decimal_places=2, null=True, blank=True, default=Decimal("0.00")
    )
    cached_balance_updated_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["business", "passenger"],
                condition=Q(account_type="wallet"),
                name="unique_wallet_account_per_business_passenger",
            ),
            models.UniqueConstraint(
                fields=["business"],
                condition=Q(account_type="business_clearing"),
                name="unique_clearing_account_per_business",
            ),
            models.UniqueConstraint(
                fields=["business", "psp_provider"],
                condition=Q(account_type="psp_suspense"),
                name="unique_psp_suspense_account_per_business_provider",
            ),
            models.UniqueConstraint(
                fields=["business"],
                condition=Q(account_type="refund_contra"),
                name="unique_refund_contra_account_per_business",
            ),
            models.UniqueConstraint(
                fields=["account_type"],
                condition=Q(account_type="integra_commission"),
                name="single_integra_commission_account",
            ),
            models.CheckConstraint(
                condition=(
                    Q(account_type="wallet", passenger__isnull=False)
                    | (~Q(account_type="wallet") & Q(passenger__isnull=True))
                ),
                name="ledger_account_passenger_iff_wallet",
            ),
            models.CheckConstraint(
                condition=(
                    Q(account_type="integra_commission", business__isnull=True)
                    | (~Q(account_type="integra_commission") & Q(business__isnull=False))
                ),
                name="ledger_account_business_iff_not_commission",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.account_type} ({self.business_id or 'platform'})"


class SettlementRun(BaseModel):
    """A payout batch for one Business's clearing-account balance over
    one period. `JournalEntry.settlement_run` points here, not the
    reverse (docs/adr/0006) — "unsettled clearing balance" is
    `WHERE business=? AND settlement_run IS NULL`. No execution logic
    exists yet (Phase 5 Slice 3) — this slice only defines the shape, so
    a later migration adding real financial data doesn't need a
    destructive schema change.
    """

    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        PROCESSING = "processing", "Processing"
        PAID_OUT = "paid_out", "Paid out"
        FAILED = "failed", "Failed"

    business = models.ForeignKey(Business, on_delete=models.PROTECT, related_name="+")
    period_start = models.DateField()
    period_end = models.DateField()
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.PENDING)
    initiated_by = models.ForeignKey(
        User, on_delete=models.SET_NULL, related_name="+", null=True, blank=True
    )
    total_amount = models.DecimalField(max_digits=10, decimal_places=2)
    currency = models.CharField(max_length=8)
    psp_transfer_reference = models.CharField(max_length=255, blank=True)
    psp_transfer_status = models.CharField(max_length=64, blank=True)
    executed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["business", "period_start", "period_end"],
                name="unique_settlement_run_per_business_period",
            ),
        ]

    def __str__(self) -> str:
        return (
            f"{self.business_id} settlement {self.period_start}..{self.period_end} ({self.status})"
        )


class JournalEntry(BaseModel):
    """A balanced set of `JournalLine`s.
    `apps.ledger.services.post_journal_entry` is the sole write path —
    it rejects any set of lines that doesn't sum to zero before any DB
    write, and a DB-wide sweep test re-verifies the invariant
    independently (docs/adr/0006's own "enforced by a test, not just
    application logic")."""

    class EntryType(models.TextChoices):
        PAYMENT = "payment", "Payment"
        REFUND = "refund", "Refund"
        CONCESSION = "concession", "Concession"
        TOPUP = "topup", "Wallet top-up"

    business = models.ForeignKey(Business, on_delete=models.PROTECT, related_name="+")
    entry_type = models.CharField(max_length=16, choices=EntryType.choices)
    settlement_run = models.ForeignKey(
        SettlementRun, on_delete=models.PROTECT, related_name="+", null=True, blank=True
    )
    external_reference = models.CharField(max_length=255, blank=True, db_index=True)
    memo = models.TextField(blank=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self) -> str:
        return f"{self.entry_type} entry for {self.business_id}"


class JournalLine(BaseModel):
    """One signed movement against one `LedgerAccount`. Negative =
    debit (decreases the account's balance), positive = credit
    (increases it) — this makes `SUM(amount)` per account literally the
    derived balance ADR-0006 calls for, and "debits equal credits"
    collapse to the single testable invariant `SUM(amount) == 0` per
    `JournalEntry`."""

    journal_entry = models.ForeignKey(JournalEntry, on_delete=models.PROTECT, related_name="+")
    account = models.ForeignKey(LedgerAccount, on_delete=models.PROTECT, related_name="+")
    amount = models.DecimalField(max_digits=10, decimal_places=2)
    currency = models.CharField(max_length=8)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self) -> str:
        return f"{self.amount} {self.currency} on {self.account_id}"
