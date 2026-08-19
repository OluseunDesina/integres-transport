from collections import defaultdict
from typing import Any

from drf_spectacular.utils import extend_schema_field
from rest_framework import serializers

from .models import Business, KybDocument
from .services import create_business, update_business


class BusinessSerializer(serializers.ModelSerializer[Business]):
    class Meta:
        model = Business
        fields = [
            "id",
            "vertical",
            "name",
            "currency",
            "timezone",
            "booking_mode_default",
            "fare_pricing_mode",
            "is_active",
            "kyb_status",
            "kyb_submitted_at",
            "created_at",
        ]
        read_only_fields = ["id", "kyb_status", "kyb_submitted_at", "created_at"]

    def create(self, validated_data: dict[str, Any]) -> Business:
        request = self.context["request"]
        assert request.user.client is not None
        return create_business(
            client=request.user.client,
            vertical=validated_data["vertical"],
            name=validated_data["name"],
            currency=validated_data["currency"],
            timezone_name=validated_data["timezone"],
            booking_mode_default=validated_data["booking_mode_default"],
            # .get(), not ["..."]: unlike every other field here,
            # fare_pricing_mode has a model default and DRF's
            # ModelSerializer marks it `required=False` for that reason
            # — but does NOT populate validated_data with the model's
            # default when the field is simply omitted from the request
            # (that only happens automatically for the un-overridden
            # `Model.objects.create(**validated_data)` path; this
            # create() indexes explicitly instead). Caught live by this
            # slice's own test suite — every pre-Phase-4 field here was
            # required, so this gap was never exercised until now.
            fare_pricing_mode=validated_data.get(
                "fare_pricing_mode", Business.FarePricingMode.FLAT
            ),
            created_by=request.user,
        )

    def update(self, instance: Business, validated_data: dict[str, Any]) -> Business:
        request = self.context["request"]
        return update_business(business=instance, updated_by=request.user, **validated_data)


class BusinessSuperAdminSerializer(serializers.ModelSerializer[Business]):
    """Read-only cross-client Business search for platform staff —
    Phase 5 frontend Slice C. Unlike `BusinessKybQueueSerializer`, not
    filtered to any `kyb_status` (that queue drops a Business the
    moment it's decided; this is the general "pick a Business" list
    platform staff need before configuring its Paystack payout account
    or triggering a settlement run, neither of which existed before)."""

    client_name = serializers.CharField(source="client.name", read_only=True)

    class Meta:
        model = Business
        fields = [
            "id",
            "client",
            "client_name",
            "name",
            "vertical",
            "currency",
            "is_active",
            "kyb_status",
            "created_at",
        ]
        read_only_fields = fields


class BusinessSeatHoldSerializer(serializers.Serializer):
    """Request body and response shape for the super-admin-only PATCH —
    docs/adr/0004. A plain Serializer, not a ModelSerializer: this
    endpoint's writable surface is exactly one field, deliberately
    never exposed on BusinessSerializer itself (see
    Business.seat_hold_minutes's own docstring). `id` is read-only,
    included only so the response confirms which Business was updated —
    BusinessSerializer itself can't be reused for the response since it
    doesn't include seat_hold_minutes at all."""

    id = serializers.UUIDField(read_only=True)
    seat_hold_minutes = serializers.IntegerField(min_value=1)


class KybDocumentSerializer(serializers.ModelSerializer[KybDocument]):
    class Meta:
        model = KybDocument
        fields = ["id", "document_type", "file", "status", "created_at"]
        read_only_fields = ["id", "status", "created_at"]


class BusinessKybQueueSerializer(serializers.ModelSerializer[Business]):
    client_name = serializers.CharField(source="client.name", read_only=True)
    documents = serializers.SerializerMethodField()

    class Meta:
        model = Business
        fields = [
            "id",
            "client",
            "client_name",
            "vertical",
            "name",
            "kyb_status",
            "kyb_submitted_at",
            "documents",
        ]
        read_only_fields = fields

    @extend_schema_field(KybDocumentSerializer(many=True))
    def get_documents(self, obj: Business) -> Any:
        # all_objects, not objects: the caller here is platform staff
        # (client_id=None in their JWT) — see this slice's plan for why
        # the default TenantScopedManager would short-circuit to empty.
        #
        # Batched, not one query per row — same N+1 fix and reasoning as
        # apps.clients.serializers.ClientKycQueueSerializer.get_documents,
        # found during the Phase 1 self-check's query-count audit.
        if getattr(self, "_documents_cache", None) is None:
            parent_instance = self.parent.instance if self.parent is not None else None
            businesses = parent_instance if parent_instance is not None else [obj]
            business_ids = [business.id for business in businesses]
            documents = KybDocument.all_objects.filter(business_id__in=business_ids)
            cache: dict[Any, list[KybDocument]] = defaultdict(list)
            for document in documents:
                cache[document.business_id].append(document)
            self._documents_cache = cache
        return KybDocumentSerializer(self._documents_cache.get(obj.id, []), many=True).data


class KybDecisionSerializer(serializers.Serializer):
    DECISION_CHOICES = ("approve", "reject")

    decision = serializers.ChoiceField(choices=DECISION_CHOICES)
    reason = serializers.CharField(required=False, allow_blank=True)

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        if attrs["decision"] == "reject" and not attrs.get("reason"):
            raise serializers.ValidationError(
                {"reason": "A reason is required when rejecting."}
            )
        return attrs
