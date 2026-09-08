from typing import Any

from django.conf import settings
from django.contrib.auth.models import AnonymousUser
from django.db.models import QuerySet
from django.shortcuts import get_object_or_404
from django.utils import timezone
from drf_spectacular.utils import OpenApiParameter, extend_schema, extend_schema_view
from rest_framework import generics
from rest_framework.authentication import BaseAuthentication
from rest_framework.exceptions import AuthenticationFailed
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.serializers import BaseSerializer
from rest_framework.throttling import SimpleRateThrottle
from rest_framework.views import APIView

from apps.core.permissions import HasPermission
from apps.identity.models import User
from apps.scheduling.models import Trip

from .live import (
    compute_fleet_etag,
    current_position_for,
    include_in_delta,
    live_states_by_vehicle,
    live_trips_queryset,
    passenger_holds_trip,
    staff_can_view_live,
    trip_live_envelope,
)
from .models import TelemetryDevice
from .serializers import (
    PositionIngestResultSerializer,
    PositionReadingSerializer,
    TelemetryDeviceCreateSerializer,
    TelemetryDeviceIssuedSerializer,
    TelemetryDeviceListQuerySerializer,
    TelemetryDeviceSerializer,
    TelemetryDeviceUpdateSerializer,
    TripLiveEnvelopeSerializer,
    TripsLiveQuerySerializer,
    TripsLiveResponseSerializer,
)
from .services import (
    DeviceNotAssigned,
    InvalidDeviceToken,
    authenticate_device,
    issue_device,
    record_device_positions,
)


def _as_plain_dict(params: dict[str, Any]) -> dict[str, Any]:
    """A QueryDict as an ordinary dict — see `apps.fleet.views
    ._apply_list_query`'s own comment: DRF's `BooleanField.get_value`
    treats anything with `getlist` (every QueryDict) as HTML form input,
    substituting `False` for a *missing* `is_active` rather than leaving
    it absent."""
    return params.dict() if hasattr(params, "dict") else dict(params)


@extend_schema_view(
    post=extend_schema(
        request=TelemetryDeviceCreateSerializer, responses=TelemetryDeviceIssuedSerializer
    )
)
class TelemetryDeviceListCreateView(generics.ListCreateAPIView[TelemetryDevice]):
    """GET/POST /telemetry/devices/ — both gated on `fleet.manage`, per
    the spec's API table (device management has no separate `.view`
    codename)."""

    permission_classes = [HasPermission("fleet.manage")]

    def get_queryset(self) -> QuerySet[TelemetryDevice]:
        queryset = TelemetryDevice.objects.select_related("business", "vehicle").all()
        query = TelemetryDeviceListQuerySerializer(data=_as_plain_dict(self.request.query_params))
        query.is_valid(raise_exception=True)

        business = query.validated_data.get("business")
        if business is not None:
            queryset = queryset.filter(business=business)

        is_active = query.validated_data.get("is_active")
        if is_active is not None:
            queryset = queryset.filter(is_active=is_active)

        return queryset

    def get_serializer_class(self) -> type[BaseSerializer[TelemetryDevice]]:
        return (
            TelemetryDeviceCreateSerializer
            if self.request.method == "POST"
            else TelemetryDeviceSerializer
        )

    def create(self, request: Request, *args: object, **kwargs: object) -> Response:
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = request.user
        assert isinstance(user, User)
        device, token = issue_device(
            business=serializer.validated_data["business"],
            label=serializer.validated_data["label"],
            vehicle=serializer.validated_data.get("vehicle"),
            issued_by=user,
        )
        response = TelemetryDeviceIssuedSerializer(device, context={"token": token})
        return Response(response.data, status=201)


@extend_schema_view(
    patch=extend_schema(
        request=TelemetryDeviceUpdateSerializer, responses=TelemetryDeviceSerializer
    )
)
class TelemetryDeviceUpdateView(generics.UpdateAPIView[TelemetryDevice]):
    """PATCH /telemetry/devices/{id}/ — revoke and/or reassign."""

    permission_classes = [HasPermission("fleet.manage")]
    serializer_class = TelemetryDeviceUpdateSerializer
    http_method_names = ["patch"]

    def get_queryset(self) -> QuerySet[TelemetryDevice]:
        return TelemetryDevice.objects.all()

    def update(self, request: Request, *args: object, **kwargs: object) -> Response:
        instance = self.get_object()
        serializer = self.get_serializer(instance, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        device = serializer.save()
        return Response(TelemetryDeviceSerializer(device).data)


class DeviceTokenAuthentication(BaseAuthentication):
    """`Authorization: Device <raw-token>` — a device is hardware, not a
    user, so this is not JWT. Resolves to `(AnonymousUser(), device)`;
    call sites read the device off `request.auth`, DRF's own slot for
    "whatever the authenticator decided", exactly as `request.user`
    is DRF's slot for the principal.

    `authenticate_header()` returning a real scheme name is load-bearing,
    not decoration: DRF's `APIView.handle_exception` downgrades every
    `AuthenticationFailed` to a bare 403 unless *some* authenticator on
    the view returns a truthy `authenticate_header()` — with
    `authentication_classes = []` (this view's first cut), a revoked or
    unknown device token silently came back as 403, contradicting the
    spec's own edge-case table ("Revoked device: 401").
    """

    def authenticate(self, request: Request) -> tuple[Any, TelemetryDevice]:
        auth_header = request.headers.get("Authorization", "")
        if not auth_header.startswith("Device "):
            raise AuthenticationFailed("Missing device token.")
        raw_token = auth_header[len("Device ") :]
        try:
            device = authenticate_device(raw_token=raw_token)
        except InvalidDeviceToken as exc:
            raise AuthenticationFailed(str(exc)) from exc
        return (AnonymousUser(), device)

    def authenticate_header(self, request: Request) -> str:
        return "Device"


class DeviceRateThrottle(SimpleRateThrottle):
    """Keys on the resolved `TelemetryDevice` (`request.auth`, set by
    `DeviceTokenAuthentication`), not `request.user` — a device has no
    JWT, so the stock `ScopedRateThrottle` would fall back to the
    caller's IP, sharing one bucket across every device behind the same
    depot NAT and splitting one device's own budget across every IP it
    roams to. DRF's own `initial()` runs authentication before throttle
    checks, so `request.auth` is already the device by the time this
    runs."""

    scope = "telemetry_ingest"

    def get_cache_key(self, request: Request, view: APIView) -> str | None:
        device = request.auth
        if device is None:
            return None
        return self.cache_format % {"scope": self.scope, "ident": device.pk}


def _parse_readings(raw_positions: list[Any]) -> tuple[list[dict[str, Any]], int]:
    """Per-row lenient validation: a malformed row is skipped and
    counted, never grounds for rejecting the whole batch (spec: "a
    single bad reading cannot block a device forever"). Each row is
    validated with its own `PositionReadingSerializer` instance, not
    `many=True` — a `ListSerializer.is_valid(raise_exception=True)`
    would fail the entire batch on the first bad item."""
    readings: list[dict[str, Any]] = []
    skipped = 0
    for raw in raw_positions:
        row = PositionReadingSerializer(data=raw if isinstance(raw, dict) else {})
        if row.is_valid():
            readings.append(row.validated_data)
        else:
            skipped += 1
    return readings, skipped


@extend_schema(exclude=True)
class PositionIngestView(APIView):
    """POST /telemetry/positions/ — `Authorization: Device <raw-token>`,
    not JWT; a device is hardware, not a user. `permission_classes =
    [AllowAny]` because the real gate here is authentication succeeding
    at all, not any Role/permission check.

    Excluded from the generated schema, the same reason
    `apps.payments.views.PaystackWebhookView` is: no Angular client here
    ever calls it (only physical devices and the simulator do), and
    drf-spectacular has no `OpenApiAuthenticationExtension` for the
    custom `DeviceTokenAuthentication` scheme to resolve it against."""

    permission_classes = [AllowAny]
    authentication_classes = [DeviceTokenAuthentication]
    throttle_classes = [DeviceRateThrottle]

    def post(self, request: Request) -> Response:
        body = request.data
        raw_positions = body.get("positions") if isinstance(body, dict) else None
        if not isinstance(raw_positions, list) or not raw_positions:
            return Response({"detail": "positions must be a non-empty list."}, status=400)

        readings, skipped = _parse_readings(raw_positions)
        device = request.auth
        assert isinstance(device, TelemetryDevice)
        try:
            result = record_device_positions(device=device, readings=readings)
        except DeviceNotAssigned as exc:
            return Response({"detail": str(exc)}, status=409)

        result["skipped"] = skipped
        return Response(PositionIngestResultSerializer(result).data, status=202)


_SINCE_PARAM = OpenApiParameter(
    "since",
    str,
    OpenApiParameter.QUERY,
    required=False,
    description="ISO-8601 timestamp. Narrows the response to trips whose "
    "live state changed after this instant — see "
    "`apps.telemetry.live.include_in_delta`. Omit for a full snapshot.",
)


@extend_schema_view(
    get=extend_schema(
        operation_id="trips_live_list",
        parameters=[_SINCE_PARAM],
        responses=TripsLiveResponseSerializer,
    )
)
class TripsLiveView(APIView):
    """GET /trips/live/ — every in-progress trip with live state.
    `scheduling.view`, the same codename that gates the rest of the
    scheduling read surface: live monitoring is scheduling visibility,
    not a new capability — the spec's own call for why this needed no
    new permission codename.

    `ETag`/`If-None-Match` is checked **before** any per-trip envelope
    is built (occupancy and incident counts included), so a genuinely
    quiet poll costs one cheap query, not one per trip. `?since=` then
    narrows a real `200` to the trips that actually moved — see
    `apps.telemetry.live.compute_fleet_etag`/`include_in_delta` for why
    these are two independent layers, not one mechanism."""

    permission_classes = [HasPermission("scheduling.view")]

    def get(self, request: Request) -> Response:
        query = TripsLiveQuerySerializer(data=request.query_params)
        query.is_valid(raise_exception=True)
        since = query.validated_data.get("since")

        trips = list(live_trips_queryset())
        states_by_vehicle = live_states_by_vehicle(trips)

        etag = compute_fleet_etag(trips, states_by_vehicle)
        if request.headers.get("If-None-Match") == etag:
            response = Response(status=304)
            response["ETag"] = etag
            return response

        results = [
            trip_live_envelope(trip=trip, position=states_by_vehicle.get(trip.vehicle_id))
            for trip in trips
            if include_in_delta(trip, states_by_vehicle.get(trip.vehicle_id), since)
        ]
        body = {
            "results": results,
            "poll_interval_seconds": settings.TELEMETRY_POLL_INTERVAL_SECONDS,
            "server_time": timezone.now(),
        }
        response = Response(TripsLiveResponseSerializer(body).data)
        response["ETag"] = etag
        return response


@extend_schema_view(
    get=extend_schema(operation_id="trip_live_retrieve", responses=TripLiveEnvelopeSerializer)
)
class TripLiveDetailView(APIView):
    """GET /trips/{id}/live/ — one trip's live detail. `scheduling.view`
    staff, or a passenger holding a ticket (or, on a pay-as-you-go trip,
    a fare journey) on it — checked by hand rather than via
    `permission_classes`, since neither `HasPermission` nor
    `HasAnyPermission` can express "this codename, or ownership of the
    object". Another passenger's trip is a 404, never a 403: confirming
    it exists is exactly what a 403 would do, and an unknown trip id is
    already a 404 by construction (`Trip.objects` is tenant-scoped)."""

    permission_classes = [IsAuthenticated]

    def get(self, request: Request, pk: str) -> Response:
        trip = get_object_or_404(
            Trip.objects.select_related("route", "business", "vehicle", "driver"), pk=pk
        )
        user = request.user
        assert isinstance(user, User)
        if not (staff_can_view_live(user=user) or passenger_holds_trip(trip=trip, user=user)):
            return Response(status=404)

        position = current_position_for(trip)
        envelope = trip_live_envelope(trip=trip, position=position)
        return Response(TripLiveEnvelopeSerializer(envelope).data)
