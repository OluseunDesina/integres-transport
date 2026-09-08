from typing import Any

from drf_spectacular.utils import extend_schema_field
from rest_framework import serializers

from apps.businesses.models import Business

from .models import Driver, Vehicle, VehicleType
from .services import (
    compliance_warnings_for,
    create_driver,
    create_vehicle,
    create_vehicle_type,
    update_driver,
    update_vehicle,
    update_vehicle_type,
)


def _get_business(value: Any) -> Business:
    try:
        return Business.objects.get(pk=value)
    except Business.DoesNotExist:
        raise serializers.ValidationError("Unknown business.", code="unknown_business") from None


class FleetListQuerySerializer(serializers.Serializer):
    """Validates `?business=<uuid>&search=&is_active=` on every GET in
    this app — same tenant-scoped-manager-lookup-or-400 convention as
    apps.network.serializers.NetworkListQuerySerializer, deliberately
    kept as its own copy rather than a cross-app import (small per-app
    serializers of near-identical shape is the established precedent,
    see apps.identity's own StaffInvitationCreatedResponseSerializer
    docstring).

    `search` is validated here and applied by each view, which owns its
    own field list — a VehicleType is found by name, a Vehicle by
    registration, a Driver by name/phone/licence. It only ever narrows,
    so no term a caller can type reaches another Client's rows
    (docs/specs/14-design-system-and-ui-rebuild.md, slice 3a)."""

    business = serializers.UUIDField(required=False)
    # `allow_blank`: the frontend filter bar emits '' when its search box
    # is cleared, and rejecting that would 400 on the way back to the
    # unfiltered list.
    search = serializers.CharField(required=False, allow_blank=True)
    is_active = serializers.BooleanField(required=False)

    def validate_business(self, value: Any) -> Business:
        return _get_business(value)


class VehicleTypeSerializer(serializers.ModelSerializer[VehicleType]):
    class Meta:
        model = VehicleType
        fields = ["id", "business", "name", "capacity", "trip_class", "is_active", "created_at"]
        read_only_fields = ["id", "business", "created_at"]

    def update(self, instance: VehicleType, validated_data: dict[str, Any]) -> VehicleType:
        request = self.context["request"]
        return update_vehicle_type(vehicle_type=instance, updated_by=request.user, **validated_data)


class VehicleTypeCreateSerializer(serializers.Serializer):
    business = serializers.UUIDField()
    name = serializers.CharField(max_length=100)
    capacity = serializers.IntegerField(min_value=1)
    # `required=False` with **no** `default=`, deliberately: a serializer
    # default makes drf-spectacular emit the field as *required* in the
    # generated request type (the same quirk `RouteCreate.code` already
    # carries), which would force every existing caller to start sending
    # it. Omitted here means the key is absent from validated_data and
    # the service's own `Business.TripClass.STANDARD` default applies —
    # one default, in one place.
    trip_class = serializers.ChoiceField(choices=Business.TripClass.choices, required=False)

    def validate_business(self, value: Any) -> Business:
        return _get_business(value)

    def create(self, validated_data: dict[str, Any]) -> VehicleType:
        request = self.context["request"]
        return create_vehicle_type(created_by=request.user, **validated_data)


class VehicleSerializer(serializers.ModelSerializer[Vehicle]):
    compliance_warnings = serializers.SerializerMethodField()

    class Meta:
        model = Vehicle
        fields = [
            "id",
            "business",
            "vehicle_type",
            "registration_number",
            "insurance_expires_at",
            "roadworthiness_expires_at",
            "is_active",
            "compliance_warnings",
            "created_at",
        ]
        read_only_fields = ["id", "business", "vehicle_type", "created_at"]

    @extend_schema_field(serializers.ListField(child=serializers.CharField()))
    def get_compliance_warnings(self, obj: Vehicle) -> list[str]:
        return compliance_warnings_for(obj)

    def update(self, instance: Vehicle, validated_data: dict[str, Any]) -> Vehicle:
        request = self.context["request"]
        return update_vehicle(vehicle=instance, updated_by=request.user, **validated_data)


class VehicleCreateSerializer(serializers.Serializer):
    business = serializers.UUIDField()
    vehicle_type = serializers.UUIDField()
    registration_number = serializers.CharField(max_length=32)
    insurance_expires_at = serializers.DateField(required=False, allow_null=True, default=None)
    roadworthiness_expires_at = serializers.DateField(
        required=False, allow_null=True, default=None
    )

    def validate_business(self, value: Any) -> Business:
        return _get_business(value)

    def validate_vehicle_type(self, value: Any) -> VehicleType:
        try:
            return VehicleType.objects.get(pk=value)
        except VehicleType.DoesNotExist:
            raise serializers.ValidationError(
                "Unknown vehicle type.", code="unknown_vehicle_type"
            ) from None

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        business = attrs.get("business")
        vehicle_type = attrs.get("vehicle_type")
        if (
            business is not None
            and vehicle_type is not None
            and vehicle_type.business_id != business.id
        ):
            raise serializers.ValidationError(
                {"vehicle_type": "This vehicle type belongs to a different Business."},
                code="vehicle_type_business_mismatch",
            )
        registration_number = attrs.get("registration_number")
        if (
            business is not None
            and registration_number
            and Vehicle.objects.filter(
                client=business.client, registration_number=registration_number
            ).exists()
        ):
            raise serializers.ValidationError(
                {"registration_number": "A vehicle with this registration number already exists."},
                code="duplicate_registration_number",
            )
        return attrs

    def create(self, validated_data: dict[str, Any]) -> Vehicle:
        request = self.context["request"]
        return create_vehicle(created_by=request.user, **validated_data)


class DriverSerializer(serializers.ModelSerializer[Driver]):
    compliance_warnings = serializers.SerializerMethodField()

    class Meta:
        model = Driver
        fields = [
            "id",
            "business",
            "name",
            "phone",
            "license_number",
            "license_expires_at",
            "is_active",
            "compliance_warnings",
            "created_at",
        ]
        read_only_fields = ["id", "business", "created_at"]

    @extend_schema_field(serializers.ListField(child=serializers.CharField()))
    def get_compliance_warnings(self, obj: Driver) -> list[str]:
        return compliance_warnings_for(obj)

    def update(self, instance: Driver, validated_data: dict[str, Any]) -> Driver:
        request = self.context["request"]
        return update_driver(driver=instance, updated_by=request.user, **validated_data)


class DriverCreateSerializer(serializers.Serializer):
    business = serializers.UUIDField()
    name = serializers.CharField(max_length=255)
    phone = serializers.CharField(max_length=32, required=False, allow_blank=True, default="")
    license_number = serializers.CharField(max_length=64)
    license_expires_at = serializers.DateField(required=False, allow_null=True, default=None)

    def validate_business(self, value: Any) -> Business:
        return _get_business(value)

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        business = attrs.get("business")
        license_number = attrs.get("license_number")
        if (
            business is not None
            and license_number
            and Driver.objects.filter(
                client=business.client, license_number=license_number
            ).exists()
        ):
            raise serializers.ValidationError(
                {"license_number": "A driver with this license number already exists."},
                code="duplicate_license_number",
            )
        return attrs

    def create(self, validated_data: dict[str, Any]) -> Driver:
        request = self.context["request"]
        return create_driver(created_by=request.user, **validated_data)
