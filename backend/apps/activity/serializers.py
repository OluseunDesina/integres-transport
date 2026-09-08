"""Serializers for apps.activity."""

from rest_framework import serializers

_ENTRY_TYPES = ["wallet_topup", "booking_paid", "ticket_boarded", "fare_deducted"]


class ActivityEntrySerializer(serializers.Serializer):
    type = serializers.ChoiceField(choices=_ENTRY_TYPES)
    occurred_at = serializers.DateTimeField()
    business = serializers.CharField()
    #: `None` for a wallet top-up (no route involved) or a booking
    #: payment made before the deleted-booking edge case existed — see
    #: `apps.activity.services.list_activity`'s own docstring for why
    #: `ticket_boarded`/`fare_deducted` always carry one.
    route = serializers.CharField(allow_null=True)
    reference = serializers.CharField(allow_null=True)
    amount = serializers.DecimalField(max_digits=10, decimal_places=2, allow_null=True)
    currency = serializers.CharField(allow_null=True)
    #: `None` whenever this specific entry did not itself move the
    #: passenger's wallet balance — see `list_activity`'s own comment on
    #: why a payment or a PAYG fare is not assumed to have.
    wallet_balance = serializers.DecimalField(max_digits=10, decimal_places=2, allow_null=True)


class ActivityResponseSerializer(serializers.Serializer):
    results = ActivityEntrySerializer(many=True)
    poll_interval_seconds = serializers.IntegerField()
