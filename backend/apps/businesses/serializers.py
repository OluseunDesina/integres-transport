from collections import defaultdict
from typing import Any

from drf_spectacular.utils import extend_schema_field
from rest_framework import serializers

from .models import Business, Director, KybDocument
from .services import create_business, update_business


class BusinessListQuerySerializer(serializers.Serializer):
    """Query shape for the Client-scoped GET /businesses/ — this
    endpoint's first, added by spec 14 slice 3b so its filter bar has
    something real behind it. The cross-client super-admin list has had
    its own `?search=` since Phase 5.

    `allow_blank`, because the filter bar emits '' when its search box is
    cleared, and rejecting that would 400 on the way back to the
    unfiltered list."""

    search = serializers.CharField(required=False, allow_blank=True)


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
            "fare_collection_mode",
            "seat_selection_enabled",
            "capacity_enforced",
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
            # Same .get()-not-[] reasoning as fare_pricing_mode above —
            # all three have model defaults, so DRF marks them
            # required=False and leaves validated_data without them when
            # the request omits them (docs/specs/10-booking-modes.md).
            fare_collection_mode=validated_data.get(
                "fare_collection_mode", Business.FareCollectionMode.PREPAID
            ),
            seat_selection_enabled=validated_data.get("seat_selection_enabled", True),
            capacity_enforced=validated_data.get("capacity_enforced", True),
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
            # Added by docs/specs/10-booking-modes.md slice 4, for the
            # seat-hold screen: a seat hold is a reservation-mode
            # concept, and that screen has no other way to know whether
            # the setting it edits does anything for this Business.
            "booking_mode_default",
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


class DirectorSerializer(serializers.ModelSerializer[Director]):
    """docs/specs/11-kyb-directors.md. `business` is read-only — it comes
    from the URL (`/businesses/{business_id}/directors/`), never the
    body, so a director cannot be created against a Business the caller
    didn't address."""

    class Meta:
        model = Director
        fields = [
            "id",
            "business",
            "full_name",
            "id_type",
            "id_number",
            "is_active",
            "created_at",
        ]
        read_only_fields = ["id", "business", "created_at"]


class KybDocumentSerializer(serializers.ModelSerializer[KybDocument]):
    """`director` is a plain UUIDField resolved in `validate_director`
    below, **not** a `PrimaryKeyRelatedField(queryset=...)`.

    That distinction is load-bearing: DRF's `SerializerMetaclass`
    collects declared fields at class-body execution time, so a
    `queryset=Director.objects.all()` here would be evaluated once at
    import — before any request has set a tenancy contextvar — and
    freeze to an empty queryset forever, rejecting every real director.
    `apps.identity`'s `Role` field hit exactly this in Phase 1 Slice 4;
    resolving the FK inside a `validate_<field>()` method is the
    established fix.
    """

    director = serializers.UUIDField(required=False, allow_null=True, default=None)

    class Meta:
        model = KybDocument
        fields = ["id", "director", "document_type", "file", "status", "created_at"]
        read_only_fields = ["id", "status", "created_at"]

    def to_representation(self, instance: KybDocument) -> dict[str, Any]:
        """Emit `director` as the FK id, not the related object.

        Without this, the declared `UUIDField` serializes whatever
        `validate_director` put in `validated_data` — a `Director`
        *instance* — through `str()`, which hits `Director.__str__` and
        returns the director's **name**. The response then disagrees
        with the OpenAPI schema (which says `format: uuid`), and a
        typed frontend receives a string it cannot use to reference the
        director. Caught by a live round-trip, not by the unit tests,
        which asserted `document.director_id` on the model rather than
        the serialized payload.
        """
        data = super().to_representation(instance)
        data["director"] = str(instance.director_id) if instance.director_id else None
        return data

    def validate_director(self, value: Any) -> Director | None:
        if value is None:
            return None
        try:
            return Director.objects.get(pk=value)
        except Director.DoesNotExist:
            raise serializers.ValidationError(
                "Unknown director.", code="unknown_director"
            ) from None

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        # A director's ID that points at nobody looks filed but proves
        # nothing — worse than a rejected upload, so reject it.
        if (
            attrs.get("document_type") == KybDocument.DocumentType.DIRECTORS_ID
            and attrs.get("director") is None
        ):
            raise serializers.ValidationError(
                {"director": "Select which director this ID belongs to."},
                code="director_required",
            )
        director = attrs.get("director")
        business = self.context.get("business")
        if director is not None and business is not None and director.business_id != business.id:
            raise serializers.ValidationError(
                {"director": "This director belongs to a different Business."},
                code="director_business_mismatch",
            )
        return attrs


class BusinessKybQueueSerializer(serializers.ModelSerializer[Business]):
    client_name = serializers.CharField(source="client.name", read_only=True)
    documents = serializers.SerializerMethodField()
    directors = serializers.SerializerMethodField()

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
            "directors",
        ]
        read_only_fields = fields

    @extend_schema_field(DirectorSerializer(many=True))
    def get_directors(self, obj: Business) -> Any:
        # Same all_objects + batching reasoning as get_documents below —
        # a reviewer needs to see *who* they're approving, not infer it
        # from filenames, and doing that per row would reintroduce
        # exactly the N+1 that audit already fixed once.
        #
        # Inactive directors are included deliberately: a soft-removed
        # director may still be attached to documents in this packet, and
        # hiding them would leave a reviewer looking at an ID document
        # whose owner had vanished from the list.
        if getattr(self, "_directors_cache", None) is None:
            parent_instance = self.parent.instance if self.parent is not None else None
            businesses = parent_instance if parent_instance is not None else [obj]
            business_ids = [business.id for business in businesses]
            directors = Director.all_objects.filter(business_id__in=business_ids)
            cache: dict[Any, list[Director]] = defaultdict(list)
            for director in directors:
                cache[director.business_id].append(director)
            self._directors_cache = cache
        return DirectorSerializer(self._directors_cache.get(obj.id, []), many=True).data

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
