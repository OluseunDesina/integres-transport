"""Serializers for apps.wallet."""

from typing import Any

from rest_framework import serializers

from apps.businesses.models import Business
from apps.identity.models import User
from apps.ledger.models import JournalLine


def _resolve_business(value: Any) -> Business:
    try:
        return Business.objects.get(pk=value)
    except Business.DoesNotExist:
        raise serializers.ValidationError("Unknown business.", code="unknown_business") from None


def _resolve_passenger(value: Any) -> User:
    try:
        return User.objects.get(pk=value)
    except User.DoesNotExist:
        raise serializers.ValidationError("Unknown passenger.", code="unknown_passenger") from None


class WalletTransactionSerializer(serializers.ModelSerializer[JournalLine]):
    class Meta:
        model = JournalLine
        fields = ["id", "amount", "currency", "created_at"]
        read_only_fields = fields


class WalletSerializer(serializers.Serializer):
    balance = serializers.DecimalField(max_digits=10, decimal_places=2)
    currency = serializers.CharField()
    transactions = WalletTransactionSerializer(many=True)


class WalletMineQuerySerializer(serializers.Serializer):
    business = serializers.UUIDField()

    def validate_business(self, value: Any) -> Business:
        return _resolve_business(value)


class WalletLookupQuerySerializer(serializers.Serializer):
    business = serializers.UUIDField()
    passenger = serializers.UUIDField()

    def validate_business(self, value: Any) -> Business:
        return _resolve_business(value)

    def validate_passenger(self, value: Any) -> User:
        return _resolve_passenger(value)
