"""Views for apps.incidents — see docs/specs/17-incidents.md.

Thin throughout: every mutation is one call into
`apps.incidents.services`, and each typed exception it raises maps to
exactly one status code here.

`get_queryset()` is always a method, never a `queryset =` class
attribute. A class attribute backed by `.objects` is evaluated once at
import time, before any request has established a tenancy context, and
freezes to an empty queryset forever.
"""

from django.db.models import Q, QuerySet
from django.shortcuts import get_object_or_404
from drf_spectacular.utils import OpenApiParameter, extend_schema, extend_schema_view
from rest_framework import generics, status
from rest_framework.permissions import BasePermission, IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.serializers import BaseSerializer
from rest_framework.throttling import ScopedRateThrottle

from apps.analytics.filters import as_utc_range, resolve_timezone
from apps.core.idempotency import IdempotencyKeyConflict
from apps.core.permissions import HasPermission
from apps.identity.models import User

from .models import OPEN_STATUSES, Incident
from .serializers import (
    AssignableUserSerializer,
    IncidentActivitySerializer,
    IncidentCreateSerializer,
    IncidentDetailSerializer,
    IncidentListQuerySerializer,
    IncidentNoteSerializer,
    IncidentReportSerializer,
    IncidentSerializer,
    IncidentTransitionSerializer,
    IncidentUpdateSerializer,
    PassengerIncidentSerializer,
)
from .services import (
    IllegalTransition,
    StatusNotEditable,
    activity_for,
    add_incident_note,
    create_incident,
    report_incident,
    transition_incident,
    update_incident,
)

_IDEMPOTENCY_KEY_PARAM = OpenApiParameter(
    "Idempotency-Key",
    str,
    OpenApiParameter.HEADER,
    required=True,
    description="Client-generated key. A retried request with the same key and body "
    "returns the original Incident rather than filing a second one.",
)

_LIST_QUERY_PARAMS = [
    OpenApiParameter(name, str, OpenApiParameter.QUERY, required=False)
    for name in (
        "business",
        "route",
        "trip",
        "vehicle",
        "driver",
        "assigned_to",
        "status",
        "severity",
        "category",
        "source",
        "open_only",
        "date_from",
        "date_to",
        "search",
    )
]

#: Everything the list and detail shapes read a label off. Without these
#: joins each row costs six extra queries, which a bounded-query test
#: pins.
_RELATED = (
    "business",
    "route",
    "stop",
    "driver",
    "vehicle",
    "reported_by",
    "assigned_to",
)


def _idempotency_key_or_400(request: Request) -> tuple[str, Response | None]:
    key = request.headers.get("Idempotency-Key")
    if not key:
        return "", Response(
            {"detail": "Idempotency-Key header is required."},
            status=status.HTTP_400_BAD_REQUEST,
        )
    return key, None


# --- staff-facing ----------------------------------------------------------


@extend_schema_view(
    get=extend_schema(parameters=_LIST_QUERY_PARAMS, responses=IncidentSerializer),
    post=extend_schema(
        request=IncidentCreateSerializer,
        responses=IncidentSerializer,
        parameters=[_IDEMPOTENCY_KEY_PARAM],
    ),
)
class IncidentListCreateView(generics.ListCreateAPIView[Incident]):
    """`GET`/`POST /incidents/` — the operator queue and its create form."""

    def get_permissions(self) -> list[BasePermission]:
        if self.request.method == "POST":
            return [HasPermission("incidents.manage")()]
        return [HasPermission("incidents.view")()]

    def get_serializer_class(self) -> type[BaseSerializer[Incident]]:
        if self.request.method == "POST":
            return IncidentCreateSerializer
        return IncidentSerializer

    def get_queryset(self) -> QuerySet[Incident]:
        queryset = Incident.objects.select_related(*_RELATED).all()
        query = IncidentListQuerySerializer(
            data=self.request.query_params.dict(), context={"request": self.request}
        )
        query.is_valid(raise_exception=True)
        data = query.validated_data

        for field in ("business", "route", "trip", "vehicle", "driver", "assigned_to"):
            value = data.get(field)
            if value is not None:
                queryset = queryset.filter(**{field: value})

        for field in ("status", "severity", "category", "source"):
            value = data.get(field)
            if value is not None:
                queryset = queryset.filter(**{field: value})

        if data.get("open_only"):
            queryset = queryset.filter(status__in=OPEN_STATUSES)

        # No default period. A record list is bounded by its own
        # pagination; inheriting an aggregate's rolling window is how
        # `GET /payments/` spent two specs unable to find a two-month-old
        # payment (docs/specs/16-operational-analytics.md, slice 4).
        date_from = data.get("date_from")
        date_to = data.get("date_to")
        if date_from is not None or date_to is not None:
            tz_name = resolve_timezone(business=data.get("business"))
            if date_from is not None:
                start, _ = as_utc_range(date_from=date_from, date_to=date_from, tz_name=tz_name)
                queryset = queryset.filter(created_at__gte=start)
            if date_to is not None:
                _, end = as_utc_range(date_from=date_to, date_to=date_to, tz_name=tz_name)
                queryset = queryset.filter(created_at__lt=end)

        search = data.get("search", "").strip()
        if search:
            queryset = queryset.filter(
                Q(reference__icontains=search)
                | Q(title__icontains=search)
                | Q(description__icontains=search)
                | Q(device_reference__icontains=search)
            )

        return queryset

    def create(self, request: Request, *args: object, **kwargs: object) -> Response:
        idempotency_key, error = _idempotency_key_or_400(request)
        if error is not None:
            return error
        serializer = IncidentCreateSerializer(data=request.data, context={"request": request})
        serializer.is_valid(raise_exception=True)
        user = request.user
        assert isinstance(user, User)
        data = serializer.validated_data
        try:
            incident = create_incident(
                business=data["business"],
                reported_by=user,
                idempotency_key=idempotency_key,
                title=data["title"],
                category=data["category"],
                description=data.get("description", ""),
                severity=data.get("severity", Incident.Severity.MEDIUM),
                trip=data.get("trip"),
                route=data.get("route"),
                vehicle=data.get("vehicle"),
                driver=data.get("driver"),
                stop=data.get("stop"),
                device_reference=data.get("device_reference", ""),
                assigned_to=data.get("assigned_to"),
                latitude=data.get("latitude"),
                longitude=data.get("longitude"),
            )
        except IdempotencyKeyConflict as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_409_CONFLICT)
        return Response(IncidentSerializer(incident).data, status=status.HTTP_201_CREATED)


@extend_schema_view(
    get=extend_schema(responses=IncidentDetailSerializer),
    patch=extend_schema(request=IncidentUpdateSerializer, responses=IncidentDetailSerializer),
)
class IncidentDetailView(generics.GenericAPIView[Incident]):
    """`GET`/`PATCH /incidents/{id}/`.

    `PATCH` cannot move `status` — see
    `apps.incidents.services.update_incident`. Another Client's incident
    is a 404 rather than a 403: the tenant-scoped manager simply does not
    contain it, and saying "forbidden" would confirm it exists.
    """

    def get_permissions(self) -> list[BasePermission]:
        if self.request.method == "PATCH":
            return [HasPermission("incidents.manage")()]
        return [HasPermission("incidents.view")()]

    def get_serializer_class(self) -> type[BaseSerializer[Incident]]:
        if self.request.method == "PATCH":
            return IncidentUpdateSerializer
        return IncidentDetailSerializer

    def get_queryset(self) -> QuerySet[Incident]:
        return Incident.objects.select_related(*_RELATED).all()

    def _detail_response(self, incident: Incident) -> Response:
        serializer = IncidentDetailSerializer(
            incident, context={"activities": activity_for(incident)}
        )
        return Response(serializer.data)

    def get(self, request: Request, pk: str) -> Response:
        return self._detail_response(get_object_or_404(self.get_queryset(), pk=pk))

    def patch(self, request: Request, pk: str) -> Response:
        incident = get_object_or_404(self.get_queryset(), pk=pk)
        serializer = IncidentUpdateSerializer(
            data=request.data, context={"request": request, "incident": incident}
        )
        serializer.is_valid(raise_exception=True)
        user = request.user
        assert isinstance(user, User)
        try:
            incident = update_incident(
                incident=incident,
                actor=user,
                changes=dict(serializer.validated_data),
                submitted_fields=set(request.data),
            )
        except StatusNotEditable as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        return self._detail_response(incident)


@extend_schema(request=IncidentTransitionSerializer, responses=IncidentDetailSerializer)
class IncidentTransitionView(generics.GenericAPIView[Incident]):
    """`POST /incidents/{id}/transition/` — the only way status moves."""

    permission_classes = [HasPermission("incidents.manage")]
    serializer_class = IncidentTransitionSerializer

    def get_queryset(self) -> QuerySet[Incident]:
        return Incident.objects.select_related(*_RELATED).all()

    def post(self, request: Request, pk: str) -> Response:
        incident = get_object_or_404(self.get_queryset(), pk=pk)
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = request.user
        assert isinstance(user, User)
        try:
            incident = transition_incident(
                incident=incident,
                to_status=serializer.validated_data["status"],
                actor=user,
                note=serializer.validated_data.get("note", ""),
            )
        except IllegalTransition as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_409_CONFLICT)
        return Response(
            IncidentDetailSerializer(
                incident, context={"activities": activity_for(incident)}
            ).data
        )


@extend_schema(request=IncidentNoteSerializer, responses=IncidentActivitySerializer)
class IncidentNoteView(generics.GenericAPIView[Incident]):
    """`POST /incidents/{id}/notes/` — an internal note on the trail."""

    permission_classes = [HasPermission("incidents.manage")]
    serializer_class = IncidentNoteSerializer

    def get_queryset(self) -> QuerySet[Incident]:
        return Incident.objects.all()

    def post(self, request: Request, pk: str) -> Response:
        incident = get_object_or_404(self.get_queryset(), pk=pk)
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = request.user
        assert isinstance(user, User)
        activity = add_incident_note(
            incident=incident, actor=user, note=serializer.validated_data["note"]
        )
        return Response(
            IncidentActivitySerializer(activity).data, status=status.HTTP_201_CREATED
        )


class AssignableUserListView(generics.ListAPIView[User]):
    """`GET /incidents/assignable-users/` — who an incident can be
    handed to.

    This exists because `GET /staff/` is gated on `staff.manage`, which
    only the **Owner** preset holds. Manager and Staff both hold
    `incidents.manage` and are exactly the people who triage incidents,
    so populating an assignee picker from `/staff/` would 403 for almost
    everyone who needs it.

    Narrower than `/staff/` on purpose — `AssignableUserSerializer`
    carries no Role and no permission list.

    `User` is not a `BaseModel` and `User.objects` is the plain unscoped
    manager (docs/adr/0003), so the `client` filter here is the only
    thing scoping this response.
    """

    permission_classes = [HasPermission("incidents.manage")]
    serializer_class = AssignableUserSerializer

    def get_queryset(self) -> QuerySet[User]:
        user = self.request.user
        assert isinstance(user, User)
        return User.objects.filter(client=user.client, is_client_staff=True).order_by("email")


# --- passenger-facing ------------------------------------------------------


@extend_schema(
    request=IncidentReportSerializer,
    responses=PassengerIncidentSerializer,
    parameters=[_IDEMPOTENCY_KEY_PARAM],
)
class IncidentReportView(generics.GenericAPIView[Incident]):
    """`POST /incidents/report/` — a passenger reports a problem.

    `IsAuthenticated` only, no codename: passengers have no Role
    (docs/adr/0003), so any `HasPermission` gate would exclude them by
    construction.

    Throttled, and this is the first non-auth **POST** scope in this
    backend. `ScopedRateThrottle` keys on the authenticated user, so the
    limit is per passenger — the abuse vector the spec's Failure Modes
    section names. There is no anonymous reporting to rate-limit by IP,
    because the customer app is authenticated throughout.

    Responds with the **passenger** serializer, not the staff one: the
    reporter must not learn who the incident was assigned to just
    because they filed it.
    """

    permission_classes = [IsAuthenticated]
    serializer_class = IncidentReportSerializer
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "incident_report"

    def post(self, request: Request) -> Response:
        idempotency_key, error = _idempotency_key_or_400(request)
        if error is not None:
            return error
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = request.user
        assert isinstance(user, User)
        data = serializer.validated_data
        try:
            incident = report_incident(
                business=data["business"],
                reported_by=user,
                idempotency_key=idempotency_key,
                category=data["category"],
                description=data["description"],
                title=data.get("title", ""),
                trip=data.get("trip"),
                route=data.get("route"),
                stop=data.get("stop"),
                vehicle=data.get("vehicle"),
                device_reference=data.get("device_reference", ""),
                latitude=data.get("latitude"),
                longitude=data.get("longitude"),
            )
        except IdempotencyKeyConflict as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_409_CONFLICT)
        return Response(
            PassengerIncidentSerializer(incident).data, status=status.HTTP_201_CREATED
        )


class IncidentMineView(generics.ListAPIView[Incident]):
    """`GET /incidents/mine/` — the reporter's own reports, reduced.

    Parity with `apps.booking.views.BookingMineView`. The reduced shape
    is a distinct serializer class rather than an exclusion list, so
    staff notes on a safety report cannot leak back to the person who
    filed it.
    """

    permission_classes = [IsAuthenticated]
    serializer_class = PassengerIncidentSerializer

    def get_queryset(self) -> QuerySet[Incident]:
        user = self.request.user
        assert isinstance(user, User)
        return Incident.objects.filter(reported_by=user)
