"""Serializers for apps.ticketing — see docs/specs/6-ticketing.md."""

from rest_framework import serializers

from apps.booking.models import Booking

from .models import Ticket


class TicketSerializer(serializers.ModelSerializer[Ticket]):
    # docs/specs/15-trip-classes.md slice 3. Reads through two FKs
    # (ticket -> booking -> trip), so any view returning this serializer
    # must `select_related("booking__trip")` or it is one extra query
    # per row — the same note apps.booking.serializers.BookingSerializer
    # .get_trip already carries for its own read-through.
    #
    # Sourced here rather than from the signed payload: the payload is
    # opaque to this side by design (only the validator decodes it), and
    # a ticket screen must never depend on being able to read it.
    trip_class = serializers.CharField(source="booking.trip.trip_class", read_only=True)

    class Meta:
        model = Ticket
        fields = [
            "id",
            "signed_payload",
            "status",
            "issued_at",
            "expires_at",
            "boarded_at",
            "trip_class",
        ]
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
    decoded payload (or the credential token) inside
    `apps.ticketing.services`.

    Exactly one of `payload` and `token` — the two fare media that can
    board the same Ticket (docs/specs/10-booking-modes.md). Both are
    optional in the schema and the pairing is enforced here, because
    DRF has no native "exactly one of" declaration and a required field
    per media would make each impossible to send without the other.
    """

    payload = serializers.CharField(required=False)
    token = serializers.CharField(required=False)

    def validate(self, attrs: dict[str, object]) -> dict[str, object]:
        has_payload = bool(attrs.get("payload"))
        has_token = bool(attrs.get("token"))
        if has_payload == has_token:
            raise serializers.ValidationError(
                "Send exactly one of `payload` (a scanned ticket QR) or `token` (a tap credential)."
            )
        return attrs


class TicketValidationResultSerializer(serializers.Serializer):
    """Schema-only shape for a successful validation response — not
    backed by a model, same convention as `SigningKeysResponseSerializer`
    above."""

    status = serializers.CharField()
    passenger_name = serializers.CharField()
    # Null for an open-seating ticket, which was never assigned a seat.
    # The validator shows the blank rather than inventing a seat number
    # (docs/specs/10-booking-modes.md).
    seat_number = serializers.CharField(allow_null=True)
    from_stop = serializers.CharField()
    to_stop = serializers.CharField()
    trip_departure_at = serializers.DateTimeField()
    # Lets the validator UI tell "this scan boarded the last remaining
    # seat on the booking" apart from an ordinary mid-booking scan —
    # see apps.booking.services.mark_booking_completed_if_fully_boarded.
    booking_status = serializers.ChoiceField(choices=Booking.Status.choices)
