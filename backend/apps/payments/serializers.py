"""Serializers for apps.payments — see
docs/specs/5-payments-wallet-ledger.md and, for the wallet top-up
addition, docs/specs/7-passenger-wallet.md."""

from decimal import Decimal
from typing import Any

from rest_framework import serializers

from apps.booking.models import Booking
from apps.businesses.models import Business
from apps.ledger.models import SettlementRun

from .models import PaymentIntent, PaystackAccount


def _resolve_booking(value: Any) -> Booking:
    try:
        return Booking.objects.get(pk=value)
    except Booking.DoesNotExist:
        raise serializers.ValidationError("Unknown booking.", code="unknown_booking") from None


def _resolve_business(value: Any) -> Business:
    # Business.all_objects, not .objects: the caller is always an
    # IsPlatformStaff request (SettlementRunTriggerSerializer's only
    # user), which has no client tenancy context — same
    # TenantScopedManager-frozen gotcha CLAUDE.md documents, and the
    # same reasoning apps.businesses.views.BusinessSeatHoldView already
    # applies to its own Business lookup.
    try:
        return Business.all_objects.get(pk=value)
    except Business.DoesNotExist:
        raise serializers.ValidationError("Unknown business.", code="unknown_business") from None


# --- Paystack account config (super-admin) ---------------------------------


class PaystackAccountSerializer(serializers.ModelSerializer[PaystackAccount]):
    class Meta:
        model = PaystackAccount
        fields = [
            "id",
            "bank_code",
            "account_number",
            "account_name",
            "recipient_code",
            "is_active",
            "verified_at",
        ]
        read_only_fields = ["id", "verified_at"]


# --- POST /payments/ ---------------------------------------------------


class WalletTopupInitiateSerializer(serializers.Serializer):
    """Nested shape for `PaymentInitiateSerializer.wallet_topup` — Phase
    7. `business_id` names the wallet being funded (there's no Booking
    to denormalize it from, unlike the booking-payment shape below)."""

    business_id = serializers.UUIDField()
    amount = serializers.DecimalField(
        max_digits=10, decimal_places=2, min_value=Decimal("0.01")
    )

    def validate_business_id(self, value: Any) -> Business:
        return _resolve_business(value)


class PaymentInitiateSerializer(serializers.Serializer):
    """POST /payments/ body — exactly one of `booking_id` (pay for a
    booking) or `wallet_topup` (fund the passenger's wallet with no
    Booking attached). `use_wallet_balance` is only meaningful
    alongside `booking_id`: when set, the wallet's current balance is
    applied first and only the remainder (if any) is charged via
    Paystack — see `apps.payments.services.initiate_payment_with_wallet`.
    This revisits docs/specs/7-passenger-wallet.md's original "a blend
    of the two isn't supported" non-goal; see that spec's own
    Implementation note for why the reconciliation risk it named no
    longer blocks this."""

    booking_id = serializers.UUIDField(required=False)
    use_wallet_balance = serializers.BooleanField(required=False, default=False)
    wallet_topup = WalletTopupInitiateSerializer(required=False)

    def validate_booking_id(self, value: Any) -> Booking:
        return _resolve_booking(value)

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        has_booking = "booking_id" in attrs
        has_topup = "wallet_topup" in attrs
        if has_booking == has_topup:
            raise serializers.ValidationError(
                "Provide exactly one of booking_id or wallet_topup.",
                code="ambiguous_payment_target",
            )
        if has_topup and attrs.get("use_wallet_balance"):
            raise serializers.ValidationError(
                "use_wallet_balance is only valid alongside booking_id.",
                code="use_wallet_balance_requires_booking",
            )
        return attrs


class PaymentInitiateResponseSerializer(serializers.ModelSerializer[PaymentIntent]):
    """Response shape for POST /payments/ — narrower than the full read
    serializer below, and field-renamed to match the spec's API surface
    (`authorization_url`/`reference`, not the model's own
    `psp_authorization_url`/`psp_reference` names)."""

    authorization_url = serializers.CharField(source="psp_authorization_url")
    reference = serializers.CharField(source="psp_reference")

    class Meta:
        model = PaymentIntent
        fields = ["id", "status", "authorization_url", "reference"]
        read_only_fields = fields


# --- GET /payments/, /payments/mine/, /payments/{id}/ -----------------------


class PaymentIntentSerializer(serializers.ModelSerializer[PaymentIntent]):
    class Meta:
        model = PaymentIntent
        fields = [
            "id",
            "intent_type",
            "booking",
            "wallet_business",
            "business",
            "passenger",
            "amount",
            "wallet_component_amount",
            "currency",
            "status",
            "psp_provider",
            "psp_reference",
            "psp_authorization_url",
            # docs/specs/16-operational-analytics.md slice 1. Blank on
            # every historical row and on anything that never succeeded
            # — a reader must treat that as "unknown", not as a channel.
            "channel",
            "succeeded_at",
            "failed_at",
            "requires_manual_refund",
            "created_at",
        ]
        read_only_fields = fields


class PaymentIntentListQuerySerializer(serializers.Serializer):
    business = serializers.UUIDField(required=False)
    status = serializers.ChoiceField(choices=PaymentIntent.Status.choices, required=False)
    # The PSP reference is what a passenger or Paystack quotes back
    # during a dispute, so it is the one thing worth typing here.
    # `allow_blank`, because the filter bar emits '' when cleared.
    search = serializers.CharField(required=False, allow_blank=True)


# --- GET/POST /settlement-runs/ (Phase 5 Slice 3) ---------------------------


class SettlementRunTriggerSerializer(serializers.Serializer):
    """POST /settlement-runs/ body."""

    business = serializers.UUIDField()
    period_start = serializers.DateField()
    period_end = serializers.DateField()

    def validate_business(self, value: Any) -> Business:
        return _resolve_business(value)

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        if attrs["period_start"] >= attrs["period_end"]:
            raise serializers.ValidationError(
                "period_start must be before period_end.", code="invalid_period"
            )
        return attrs


class SettlementRunSerializer(serializers.ModelSerializer[SettlementRun]):
    class Meta:
        model = SettlementRun
        fields = [
            "id",
            "business",
            "period_start",
            "period_end",
            "status",
            "initiated_by",
            "total_amount",
            "currency",
            "psp_transfer_reference",
            "psp_transfer_status",
            "executed_at",
            "created_at",
        ]
        read_only_fields = fields


class SettlementRunListQuerySerializer(serializers.Serializer):
    business = serializers.UUIDField(required=False)
