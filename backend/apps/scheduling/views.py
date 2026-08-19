from django.db.models import QuerySet
from django.shortcuts import get_object_or_404
from drf_spectacular.utils import OpenApiParameter, extend_schema, extend_schema_view
from rest_framework import generics
from rest_framework.permissions import BasePermission, IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.serializers import BaseSerializer

from apps.businesses.models import Business
from apps.core.permissions import HasPermission
from apps.identity.models import User

from .models import Schedule, Trip
from .serializers import (
    ScheduleCreateSerializer,
    ScheduleSerializer,
    SchedulingListQuerySerializer,
    TripAssignmentSerializer,
    TripCreateSerializer,
    TripListQuerySerializer,
    TripSearchQuerySerializer,
    TripSerializer,
    TripStatusSerializer,
)
from .services import assign_trip_resources, transition_trip_status

_BUSINESS_QUERY_PARAM = OpenApiParameter(
    "business",
    str,
    OpenApiParameter.QUERY,
    required=False,
    description="Filter to a single Business's rows. An unknown or "
    "another Client's Business id returns 400.",
)
_ROUTE_QUERY_PARAM = OpenApiParameter(
    "route", str, OpenApiParameter.QUERY, required=False, description="Filter to a single Route."
)
_SCHEDULE_QUERY_PARAM = OpenApiParameter(
    "schedule",
    str,
    OpenApiParameter.QUERY,
    required=False,
    description="Filter to a single Schedule.",
)
_SERVICE_DATE_QUERY_PARAM = OpenApiParameter(
    "service_date",
    str,
    OpenApiParameter.QUERY,
    required=False,
    description="Filter to a single service_date (YYYY-MM-DD).",
)
_STATUS_QUERY_PARAM = OpenApiParameter(
    "status", str, OpenApiParameter.QUERY, required=False, description="Filter to a single status."
)


@extend_schema_view(
    get=extend_schema(parameters=[_BUSINESS_QUERY_PARAM]),
    post=extend_schema(request=ScheduleCreateSerializer, responses=ScheduleSerializer),
)
class ScheduleListCreateView(generics.ListCreateAPIView[Schedule]):
    def get_permissions(self) -> list[BasePermission]:
        codename = "scheduling.manage" if self.request.method == "POST" else "scheduling.view"
        return [HasPermission(codename)()]

    def get_queryset(self) -> QuerySet[Schedule]:
        queryset = Schedule.objects.select_related("route", "business").all()
        query = SchedulingListQuerySerializer(data=self.request.query_params)
        query.is_valid(raise_exception=True)
        business = query.validated_data.get("business")
        if business is not None:
            queryset = queryset.filter(business=business)
        return queryset

    def get_serializer_class(self) -> type[BaseSerializer[Schedule]]:
        return ScheduleCreateSerializer if self.request.method == "POST" else ScheduleSerializer

    def create(self, request: Request, *args: object, **kwargs: object) -> Response:
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        schedule = serializer.save()
        return Response(ScheduleSerializer(schedule).data, status=201)


class ScheduleUpdateView(generics.UpdateAPIView[Schedule]):
    permission_classes = [HasPermission("scheduling.manage")]
    serializer_class = ScheduleSerializer
    http_method_names = ["patch"]

    def get_queryset(self) -> QuerySet[Schedule]:
        return Schedule.objects.all()


@extend_schema_view(
    get=extend_schema(
        parameters=[
            _ROUTE_QUERY_PARAM,
            _SCHEDULE_QUERY_PARAM,
            _SERVICE_DATE_QUERY_PARAM,
            _STATUS_QUERY_PARAM,
        ]
    ),
    post=extend_schema(request=TripCreateSerializer, responses=TripSerializer),
)
class TripListCreateView(generics.ListCreateAPIView[Trip]):
    def get_permissions(self) -> list[BasePermission]:
        codename = "scheduling.manage" if self.request.method == "POST" else "scheduling.view"
        return [HasPermission(codename)()]

    def get_queryset(self) -> QuerySet[Trip]:
        queryset = Trip.objects.select_related("route", "vehicle", "driver").all()
        query = TripListQuerySerializer(data=self.request.query_params)
        query.is_valid(raise_exception=True)
        route = query.validated_data.get("route")
        schedule = query.validated_data.get("schedule")
        service_date = query.validated_data.get("service_date")
        status_filter = query.validated_data.get("status")
        if route is not None:
            queryset = queryset.filter(route=route)
        if schedule is not None:
            queryset = queryset.filter(schedule=schedule)
        if service_date is not None:
            queryset = queryset.filter(service_date=service_date)
        if status_filter is not None:
            queryset = queryset.filter(status=status_filter)
        return queryset

    def get_serializer_class(self) -> type[BaseSerializer[Trip]]:
        return TripCreateSerializer if self.request.method == "POST" else TripSerializer

    def create(self, request: Request, *args: object, **kwargs: object) -> Response:
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        trip = serializer.save()
        return Response(TripSerializer(trip).data, status=201)


@extend_schema(
    parameters=[
        OpenApiParameter("route", str, OpenApiParameter.QUERY, required=True),
        OpenApiParameter(
            "service_date",
            str,
            OpenApiParameter.QUERY,
            required=True,
            description="The service date to search (YYYY-MM-DD).",
        ),
    ],
    responses=TripSerializer(many=True),
)
class TripSearchView(generics.ListAPIView[Trip]):
    """GET /trips/search/ — the passenger-facing Trip list, see
    docs/specs/4-fares-seating-booking-frontend.md §3.3.

    Separate from TripListCreateView for the same reason
    apps.network.views.RouteBrowseView is separate from
    RouteListCreateView: passengers hold no Role/Permission
    (docs/adr/0003), so this is IsAuthenticated + ordinary tenancy
    scoping. Reuses TripSerializer unchanged — `compliance_warnings` is
    useful rather than sensitive to a passenger choosing between
    departures, so forking a passenger-only subset would be extra
    surface for no gain.
    """

    permission_classes = [IsAuthenticated]
    serializer_class = TripSerializer

    def get_queryset(self) -> QuerySet[Trip]:
        query = TripSearchQuerySerializer(data=self.request.query_params)
        query.is_valid(raise_exception=True)
        # status and booking_mode are forced here, never read from the
        # query params — a passenger must not be able to widen this to
        # reach a cancelled, completed or tap_and_go Trip.
        return Trip.objects.select_related("route", "vehicle", "driver").filter(
            route=query.validated_data["route"],
            service_date=query.validated_data["service_date"],
            status=Trip.Status.SCHEDULED,
            booking_mode=Business.BookingMode.RESERVATION,
        )


@extend_schema(request=TripAssignmentSerializer, responses=TripSerializer)
class TripAssignmentUpdateView(generics.GenericAPIView[Trip]):
    permission_classes = [HasPermission("scheduling.manage")]
    serializer_class = TripAssignmentSerializer

    def get_queryset(self) -> QuerySet[Trip]:
        return Trip.objects.all()

    def patch(self, request: Request, pk: str) -> Response:
        trip = get_object_or_404(self.get_queryset(), pk=pk)
        serializer = TripAssignmentSerializer(data=request.data, context={"trip": trip})
        serializer.is_valid(raise_exception=True)
        user = request.user
        assert isinstance(user, User)
        updated = assign_trip_resources(
            trip=trip,
            vehicle=serializer.validated_data.get("vehicle"),
            driver=serializer.validated_data.get("driver"),
            updated_by=user,
        )
        return Response(TripSerializer(updated).data)


@extend_schema(request=TripStatusSerializer, responses=TripSerializer)
class TripStatusView(generics.GenericAPIView[Trip]):
    permission_classes = [HasPermission("scheduling.manage")]
    serializer_class = TripStatusSerializer

    def get_queryset(self) -> QuerySet[Trip]:
        return Trip.objects.all()

    def post(self, request: Request, pk: str) -> Response:
        trip = get_object_or_404(self.get_queryset(), pk=pk)
        serializer = TripStatusSerializer(data=request.data, context={"trip": trip})
        serializer.is_valid(raise_exception=True)
        user = request.user
        assert isinstance(user, User)
        updated = transition_trip_status(
            trip=trip,
            new_status=serializer.validated_data["status"],
            reason=serializer.validated_data.get("reason", ""),
            actor=user,
        )
        return Response(TripSerializer(updated).data)
