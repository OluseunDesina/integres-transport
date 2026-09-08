"""Serializers for apps.incidents — see docs/specs/17-incidents.md.

**Every tenant-scoped FK is a declared `UUIDField` resolved in a
`validate_<field>()` method**, never a
`PrimaryKeyRelatedField(queryset=Model.objects.all())`. That queryset is
evaluated once when `SerializerMetaclass` collects declared fields at
class-body execution time — before any request has established a
tenancy context — so it freezes to an empty queryset forever. This model
has *six* tenant-scoped relations, which the spec names as the single
most likely way to get it wrong.

`assigned_to` is the exception that proves the rule, and the spec gets
it backwards. `identity.User` is **not** a `BaseModel` (docs/adr/0003 —
`client` is nullable for platform staff), so `User.objects` is the plain
unscoped manager and resolving through it would happily find another
Client's user. It is filtered on `client` explicitly instead, the way
`apps.identity.serializers.StaffInvitationCreateSerializer.validate_role`
already does.
"""

from collections.abc import Mapping
from typing import Any

from drf_spectacular.utils import extend_schema_field
from rest_framework import serializers

from apps.businesses.models import Business
from apps.fleet.models import Driver, Vehicle
from apps.identity.models import User
from apps.network.models import Route, Stop
from apps.scheduling.models import Trip

from .models import Incident, IncidentActivity

#: The relations that carry a `business` FK of their own, checked against
#: the incident's own Business so a record cannot be filed against a
#: sibling Business's trip. Cross-*Client* references are already
#: impossible — every lookup below goes through a tenant-scoped manager
#: — but cross-*Business* ones would not be.
_BUSINESS_OWNED_FIELDS = ("trip", "route", "vehicle", "driver", "stop")


def _resolve_business(value: Any) -> Business:
    try:
        return Business.objects.get(pk=value)
    except Business.DoesNotExist:
        raise serializers.ValidationError("Unknown business.", code="unknown_business") from None


def _resolve_trip(value: Any) -> Trip:
    try:
        return Trip.objects.select_related("route", "business").get(pk=value)
    except Trip.DoesNotExist:
        raise serializers.ValidationError("Unknown trip.", code="unknown_trip") from None


def _resolve_route(value: Any) -> Route:
    try:
        return Route.objects.get(pk=value)
    except Route.DoesNotExist:
        raise serializers.ValidationError("Unknown route.", code="unknown_route") from None


def _resolve_vehicle(value: Any) -> Vehicle:
    try:
        return Vehicle.objects.get(pk=value)
    except Vehicle.DoesNotExist:
        raise serializers.ValidationError("Unknown vehicle.", code="unknown_vehicle") from None


def _resolve_driver(value: Any) -> Driver:
    try:
        return Driver.objects.get(pk=value)
    except Driver.DoesNotExist:
        raise serializers.ValidationError("Unknown driver.", code="unknown_driver") from None


def _resolve_stop(value: Any) -> Stop:
    try:
        return Stop.objects.get(pk=value)
    except Stop.DoesNotExist:
        raise serializers.ValidationError("Unknown stop.", code="unknown_stop") from None


def _resolve_staff_user(value: Any, *, context: Mapping[str, Any]) -> User:
    """`User` carries no RLS policy and no tenant-scoped manager, so the
    Client filter here is the *only* thing standing between an operator
    and assigning work to another Client's staff."""
    request = context.get("request")
    client = getattr(getattr(request, "user", None), "client", None)
    if client is None:
        raise serializers.ValidationError("Unknown user.", code="unknown_user")
    try:
        return User.objects.get(pk=value, client=client, is_client_staff=True)
    except User.DoesNotExist:
        raise serializers.ValidationError("Unknown user.", code="unknown_user") from None


def _check_business_ownership(attrs: dict[str, Any], business: Business) -> None:
    for field in _BUSINESS_OWNED_FIELDS:
        related = attrs.get(field)
        if related is not None and related.business_id != business.id:
            raise serializers.ValidationError(
                {field: f"This {field} belongs to a different business."},
                code="business_mismatch",
            )


# --- read shapes -----------------------------------------------------------


class IncidentActivitySerializer(serializers.ModelSerializer[IncidentActivity]):
    actor_email = serializers.CharField(source="actor.email", read_only=True, allow_null=True)

    class Meta:
        model = IncidentActivity
        fields = [
            "id",
            "kind",
            "actor",
            "actor_email",
            "from_status",
            "to_status",
            "note",
            "created_at",
        ]
        read_only_fields = fields


class IncidentSerializer(serializers.ModelSerializer[Incident]):
    """The staff list shape.

    **No activity trail here.** A nested trail on a paginated list is one
    extra query per row; the detail serializer below is where it belongs,
    and a query-count test pins that.
    """

    route_name = serializers.CharField(source="route.name", read_only=True, allow_null=True)
    stop_name = serializers.CharField(source="stop.name", read_only=True, allow_null=True)
    driver_name = serializers.CharField(source="driver.name", read_only=True, allow_null=True)
    vehicle_registration = serializers.CharField(
        source="vehicle.registration_number", read_only=True, allow_null=True
    )
    reported_by_email = serializers.CharField(
        source="reported_by.email", read_only=True, allow_null=True
    )
    assigned_to_email = serializers.CharField(
        source="assigned_to.email", read_only=True, allow_null=True
    )

    class Meta:
        model = Incident
        fields = [
            "id",
            "reference",
            "business",
            "title",
            "description",
            "category",
            "severity",
            "status",
            "source",
            "trip",
            "route",
            "route_name",
            "vehicle",
            "vehicle_registration",
            "driver",
            "driver_name",
            "stop",
            "stop_name",
            "device_reference",
            "reported_by",
            "reported_by_email",
            "assigned_to",
            "assigned_to_email",
            "latitude",
            "longitude",
            "resolved_at",
            "resolution_notes",
            "created_at",
            "updated_at",
        ]
        read_only_fields = fields


class IncidentDetailSerializer(IncidentSerializer):
    activities = serializers.SerializerMethodField()

    class Meta(IncidentSerializer.Meta):
        fields = [*IncidentSerializer.Meta.fields, "activities"]
        read_only_fields = fields

    @extend_schema_field(IncidentActivitySerializer(many=True))
    def get_activities(self, obj: Incident) -> list[dict[str, Any]]:
        return list(IncidentActivitySerializer(self.context["activities"], many=True).data)


class PassengerIncidentSerializer(serializers.ModelSerializer[Incident]):
    """`GET /incidents/mine/`.

    A **separate class**, not a field-exclusion list on the shared one.
    An exclusion list is one careless edit away from leaking staff
    discussion of a safety report to the passenger who filed it; a
    separate class can only leak a field someone deliberately adds.
    `assigned_to`, `resolution_notes` and the trail are all absent, and
    a test asserts their absence by key rather than by shape.
    """

    class Meta:
        model = Incident
        fields = [
            "id",
            "reference",
            "title",
            "description",
            "category",
            "status",
            "created_at",
            "resolved_at",
        ]
        read_only_fields = fields


class AssignableUserSerializer(serializers.ModelSerializer[User]):
    """`GET /incidents/assignable-users/` — just enough to populate an
    assignee picker.

    Deliberately **not** `apps.identity.serializers.StaffSerializer`,
    which nests each user's Role and that Role's full permission list.
    Choosing who to hand a broken reader to does not require knowing
    everyone's permissions, and this endpoint is reachable by every
    `incidents.manage` holder rather than only `staff.manage` (Owner).
    """

    class Meta:
        model = User
        fields = ["id", "email", "first_name", "last_name"]
        read_only_fields = fields


# --- write shapes ----------------------------------------------------------


class IncidentCreateSerializer(serializers.Serializer):
    """`POST /incidents/` body. `source` is absent on purpose — it is
    forced to `operator` in the service, never read from the request."""

    business = serializers.UUIDField()
    title = serializers.CharField(max_length=255)
    category = serializers.ChoiceField(choices=Incident.Category.choices)
    description = serializers.CharField(required=False, allow_blank=True)
    severity = serializers.ChoiceField(choices=Incident.Severity.choices, required=False)
    trip = serializers.UUIDField(required=False, allow_null=True)
    route = serializers.UUIDField(required=False, allow_null=True)
    vehicle = serializers.UUIDField(required=False, allow_null=True)
    driver = serializers.UUIDField(required=False, allow_null=True)
    stop = serializers.UUIDField(required=False, allow_null=True)
    device_reference = serializers.CharField(
        max_length=64, required=False, allow_blank=True
    )
    assigned_to = serializers.UUIDField(required=False, allow_null=True)
    latitude = serializers.DecimalField(
        max_digits=9, decimal_places=6, required=False, allow_null=True
    )
    longitude = serializers.DecimalField(
        max_digits=9, decimal_places=6, required=False, allow_null=True
    )

    def validate_business(self, value: Any) -> Business:
        return _resolve_business(value)

    def validate_trip(self, value: Any) -> Trip | None:
        return _resolve_trip(value) if value is not None else None

    def validate_route(self, value: Any) -> Route | None:
        return _resolve_route(value) if value is not None else None

    def validate_vehicle(self, value: Any) -> Vehicle | None:
        return _resolve_vehicle(value) if value is not None else None

    def validate_driver(self, value: Any) -> Driver | None:
        return _resolve_driver(value) if value is not None else None

    def validate_stop(self, value: Any) -> Stop | None:
        return _resolve_stop(value) if value is not None else None

    def validate_assigned_to(self, value: Any) -> User | None:
        return _resolve_staff_user(value, context=self.context) if value is not None else None

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        _check_business_ownership(attrs, attrs["business"])
        return attrs


class IncidentReportSerializer(serializers.Serializer):
    """`POST /incidents/report/` body — the passenger entry point.

    Narrower than the operator's on purpose. No `severity` (a passenger
    declaring their own report critical would be a one-tap way to ring
    every operator's bell), no `driver`, no `assigned_to`. `title` is
    optional and derived from the category when absent.

    `business` may be omitted **only** when a `trip` is given, since the
    trip names it. A report with neither has nothing to file it against.
    """

    category = serializers.ChoiceField(choices=Incident.Category.choices)
    description = serializers.CharField()
    business = serializers.UUIDField(required=False, allow_null=True)
    title = serializers.CharField(max_length=255, required=False, allow_blank=True)
    trip = serializers.UUIDField(required=False, allow_null=True)
    route = serializers.UUIDField(required=False, allow_null=True)
    vehicle = serializers.UUIDField(required=False, allow_null=True)
    stop = serializers.UUIDField(required=False, allow_null=True)
    device_reference = serializers.CharField(
        max_length=64, required=False, allow_blank=True
    )
    latitude = serializers.DecimalField(
        max_digits=9, decimal_places=6, required=False, allow_null=True
    )
    longitude = serializers.DecimalField(
        max_digits=9, decimal_places=6, required=False, allow_null=True
    )

    def validate_business(self, value: Any) -> Business | None:
        return _resolve_business(value) if value is not None else None

    def validate_trip(self, value: Any) -> Trip | None:
        return _resolve_trip(value) if value is not None else None

    def validate_route(self, value: Any) -> Route | None:
        return _resolve_route(value) if value is not None else None

    def validate_vehicle(self, value: Any) -> Vehicle | None:
        return _resolve_vehicle(value) if value is not None else None

    def validate_stop(self, value: Any) -> Stop | None:
        return _resolve_stop(value) if value is not None else None

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        business = attrs.get("business")
        trip = attrs.get("trip")
        if business is None:
            if trip is None:
                raise serializers.ValidationError(
                    {"business": "Provide a business, or a trip to take it from."},
                    code="business_required",
                )
            business = trip.business
            attrs["business"] = business
        _check_business_ownership(attrs, business)
        return attrs


class IncidentUpdateSerializer(serializers.Serializer):
    """`PATCH /incidents/{id}/`.

    `status` is **not declared here**, and that is not the whole
    enforcement: an undeclared field would simply be dropped, leaving an
    operator believing they had closed an incident they had not.
    `apps.incidents.services.update_incident` is handed the raw submitted
    key set and refuses `status` by name with a 400 that says where to go
    instead.
    """

    title = serializers.CharField(max_length=255, required=False)
    description = serializers.CharField(required=False, allow_blank=True)
    category = serializers.ChoiceField(choices=Incident.Category.choices, required=False)
    severity = serializers.ChoiceField(choices=Incident.Severity.choices, required=False)
    trip = serializers.UUIDField(required=False, allow_null=True)
    route = serializers.UUIDField(required=False, allow_null=True)
    vehicle = serializers.UUIDField(required=False, allow_null=True)
    driver = serializers.UUIDField(required=False, allow_null=True)
    stop = serializers.UUIDField(required=False, allow_null=True)
    device_reference = serializers.CharField(max_length=64, required=False, allow_blank=True)
    assigned_to = serializers.UUIDField(required=False, allow_null=True)
    latitude = serializers.DecimalField(
        max_digits=9, decimal_places=6, required=False, allow_null=True
    )
    longitude = serializers.DecimalField(
        max_digits=9, decimal_places=6, required=False, allow_null=True
    )
    resolution_notes = serializers.CharField(required=False, allow_blank=True)

    def validate_trip(self, value: Any) -> Trip | None:
        return _resolve_trip(value) if value is not None else None

    def validate_route(self, value: Any) -> Route | None:
        return _resolve_route(value) if value is not None else None

    def validate_vehicle(self, value: Any) -> Vehicle | None:
        return _resolve_vehicle(value) if value is not None else None

    def validate_driver(self, value: Any) -> Driver | None:
        return _resolve_driver(value) if value is not None else None

    def validate_stop(self, value: Any) -> Stop | None:
        return _resolve_stop(value) if value is not None else None

    def validate_assigned_to(self, value: Any) -> User | None:
        return _resolve_staff_user(value, context=self.context) if value is not None else None

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        incident = self.context["incident"]
        _check_business_ownership(attrs, incident.business)
        return attrs


class IncidentTransitionSerializer(serializers.Serializer):
    """`POST /incidents/{id}/transition/` body."""

    status = serializers.ChoiceField(choices=Incident.Status.choices)
    note = serializers.CharField(required=False, allow_blank=True)


class IncidentNoteSerializer(serializers.Serializer):
    """`POST /incidents/{id}/notes/` body."""

    note = serializers.CharField()


# --- query -----------------------------------------------------------------


class IncidentListQuerySerializer(serializers.Serializer):
    """`GET /incidents/` filters.

    Deliberately *not* an extension of `apps.analytics.filters`. That
    module's `status` already means a `PaymentIntent` status, and its
    `booking_status` exists precisely because one field cannot validate
    two enums; incidents would have made it three. The date window still
    reuses that module's timezone resolution rather than inventing a
    second convention — see `apps.incidents.views`.
    """

    business = serializers.UUIDField(required=False)
    route = serializers.UUIDField(required=False)
    trip = serializers.UUIDField(required=False)
    vehicle = serializers.UUIDField(required=False)
    driver = serializers.UUIDField(required=False)
    assigned_to = serializers.UUIDField(required=False)
    status = serializers.ChoiceField(choices=Incident.Status.choices, required=False)
    severity = serializers.ChoiceField(choices=Incident.Severity.choices, required=False)
    category = serializers.ChoiceField(choices=Incident.Category.choices, required=False)
    # DRF stubs type `Field.source` (the unrelated attribute controlling
    # where a field reads from) as `str | None`; a query field genuinely
    # named "source" collides with it under static typing only.
    # `SerializerMetaclass` pops declared fields out of the class body
    # entirely, so nothing shadows anything at runtime — the same
    # harmless collision `apps.tapngo.serializers` records for `label`.
    source = serializers.ChoiceField(  # type: ignore[assignment]
        choices=Incident.Source.choices, required=False
    )
    # "Everything still someone's problem", as one filter rather than
    # three repeated `status=` params. Shares `models.OPEN_STATUSES` with
    # the analytics dashboard count, so the queue and the stat above it
    # cannot disagree about what open means.
    open_only = serializers.BooleanField(required=False, default=False)
    date_from = serializers.DateField(required=False)
    date_to = serializers.DateField(required=False)
    # allow_blank: the shared filter bar submits '' when a search box is
    # cleared, the same reason `PaymentIntentListQuerySerializer` does.
    search = serializers.CharField(required=False, allow_blank=True)

    def validate_business(self, value: Any) -> Business:
        return _resolve_business(value)

    def validate_route(self, value: Any) -> Route:
        return _resolve_route(value)

    def validate_trip(self, value: Any) -> Trip:
        return _resolve_trip(value)

    def validate_vehicle(self, value: Any) -> Vehicle:
        return _resolve_vehicle(value)

    def validate_driver(self, value: Any) -> Driver:
        return _resolve_driver(value)

    def validate_assigned_to(self, value: Any) -> User:
        return _resolve_staff_user(value, context=self.context)

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        date_from = attrs.get("date_from")
        date_to = attrs.get("date_to")
        if date_from and date_to and date_from > date_to:
            raise serializers.ValidationError(
                {"date_from": "date_from cannot be after date_to."}, code="invalid_period"
            )
        return attrs
