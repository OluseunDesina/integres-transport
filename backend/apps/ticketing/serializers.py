"""Serializers for apps.ticketing — see docs/specs/6-ticketing.md."""

from rest_framework import serializers

from .models import Ticket


class TicketSerializer(serializers.ModelSerializer[Ticket]):
    class Meta:
        model = Ticket
        fields = ["id", "signed_payload", "status", "issued_at", "expires_at", "boarded_at"]
        read_only_fields = fields


class SigningKeyEntrySerializer(serializers.Serializer):
    kid = serializers.CharField()
    public_key = serializers.CharField()


class SigningKeysResponseSerializer(serializers.Serializer):
    """Schema-only shape for `GET /ticketing/signing-keys/` — not backed
    by a model, mirrors `apps.tapngo.serializers.FareJourneyTripSerializer`'s
    own "schema-only" convention for a plain-dict response."""

    keys = SigningKeyEntrySerializer(many=True)


class RevokedTicketsResponseSerializer(serializers.Serializer):
    """Schema-only shape for `GET /ticketing/revoked/`."""

    revoked_ticket_ids = serializers.ListField(child=serializers.CharField())


class TicketValidateSerializer(serializers.Serializer):
    """POST /trips/{trip_id}/tickets/validate/ body — mirrors
    `apps.tapngo.serializers.TapRecordSerializer`'s minimal shape; no FK
    resolution needed here, since everything is resolved from the
    decoded payload inside `apps.ticketing.services.validate_ticket`."""

    payload = serializers.CharField()


class TicketValidationResultSerializer(serializers.Serializer):
    """Schema-only shape for a successful validation response — not
    backed by a model, same convention as `SigningKeysResponseSerializer`
    above."""

    status = serializers.CharField()
    passenger_name = serializers.CharField()
    seat_number = serializers.CharField()
    from_stop = serializers.CharField()
    to_stop = serializers.CharField()
    trip_departure_at = serializers.DateTimeField()
