"""Serializers for apps.ledger — see docs/specs/5-payments-wallet-ledger.md."""

from typing import Any

from drf_spectacular.utils import extend_schema_field
from rest_framework import serializers

from apps.businesses.models import Business

from .models import JournalEntry, JournalLine, LedgerAccount


def _resolve_business(value: Any) -> Business:
    try:
        return Business.objects.get(pk=value)
    except Business.DoesNotExist:
        raise serializers.ValidationError("Unknown business.", code="unknown_business") from None


def _resolve_account(value: Any) -> LedgerAccount:
    try:
        return LedgerAccount.objects.get(pk=value)
    except LedgerAccount.DoesNotExist:
        raise serializers.ValidationError(
            "Unknown ledger account.", code="unknown_account"
        ) from None


class LedgerAccountSerializer(serializers.ModelSerializer[LedgerAccount]):
    class Meta:
        model = LedgerAccount
        fields = [
            "id",
            "account_type",
            "business",
            "passenger",
            "psp_provider",
            "cached_balance",
            "cached_balance_updated_at",
            "created_at",
        ]
        read_only_fields = fields


class LedgerAccountListQuerySerializer(serializers.Serializer):
    business = serializers.UUIDField()

    def validate_business(self, value: Any) -> Business:
        return _resolve_business(value)


class JournalLineNestedSerializer(serializers.ModelSerializer[JournalLine]):
    """Nested read-only shape for `JournalEntrySerializer.lines`.

    `account` is sourced from the raw `account_id` column, not the
    related `LedgerAccount` object — deliberately: dereferencing
    `line.account` would need `select_related("account")` to avoid an
    N+1, but `LedgerAccount` carries its own RLS policy, and a
    `select_related` JOIN against an RLS-protected table silently drops
    the *referencing* row (here, the `JournalLine` itself, which the
    requesting staff user's session otherwise has every right to see)
    whenever the *joined-to* row isn't visible under the current
    session — exactly the platform commission account (`client=None`),
    invisible to an ordinary Business's staff. Reading `account_id`
    directly needs no join and never triggers this."""

    account = serializers.UUIDField(source="account_id")

    class Meta:
        model = JournalLine
        fields = ["id", "account", "amount", "currency"]
        read_only_fields = fields


class JournalEntrySerializer(serializers.ModelSerializer[JournalEntry]):
    """`lines` is populated from `self.context["lines_by_entry"]`, a
    dict the view builds with one batched `JournalLine` query per page
    — `JournalLine.journal_entry` uses `related_name="+"`, so there is
    no reverse accessor/`prefetch_related` path to lean on here, the
    same reasoning `apps.tapngo`'s serializers document for their own
    FKs."""

    lines = serializers.SerializerMethodField()

    class Meta:
        model = JournalEntry
        fields = [
            "id",
            "business",
            "entry_type",
            "external_reference",
            "memo",
            "settlement_run",
            "lines",
            "created_at",
        ]
        read_only_fields = fields

    @extend_schema_field(JournalLineNestedSerializer(many=True))
    def get_lines(self, obj: JournalEntry) -> Any:
        lines = self.context.get("lines_by_entry", {}).get(str(obj.id), [])
        return JournalLineNestedSerializer(lines, many=True).data


class JournalEntryListQuerySerializer(serializers.Serializer):
    business = serializers.UUIDField()
    account = serializers.UUIDField(required=False)

    def validate_business(self, value: Any) -> Business:
        return _resolve_business(value)

    def validate_account(self, value: Any) -> LedgerAccount:
        return _resolve_account(value)
