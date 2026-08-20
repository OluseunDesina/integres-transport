from django.db.models import QuerySet
from django.shortcuts import get_object_or_404
from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework import generics, status
from rest_framework.permissions import BasePermission, IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.core.permissions import HasPermission
from apps.fleet.models import VehicleType
from apps.identity.models import User
from apps.scheduling.models import Trip

from .models import Seat
from .serializers import (
    SeatAvailabilitySerializer,
    SeatSerializer,
    TripAvailabilityQuerySerializer,
    VehicleTypeSeatsGenerateSerializer,
    VehicleTypeSeatsUpdateSerializer,
)
from .services import SeatsInUse, generate_seat_layout, get_availability, replace_vehicle_type_seats


@extend_schema(responses=SeatSerializer(many=True))
class VehicleTypeSeatsView(generics.GenericAPIView[VehicleType]):
    # Neither GET nor PUT here ever calls paginate_queryset() — both
    # return a bare list (the full seat set for one VehicleType, never
    # large enough to paginate). Without this, drf-spectacular still
    # infers a paginated response shape for GET purely from the
    # inherited DEFAULT_PAGINATION_CLASS + the view looking list-shaped,
    # even with an explicit `responses=SeatSerializer(many=True)` above
    # — a real schema/runtime mismatch caught by generate/'s own first
    # real frontend consumer (docs/specs/8-seat-map-generation.md).
    pagination_class = None

    # seating.view (GET) / seating.manage (PUT) — same per-method
    # branching precedent as apps.network.views.RouteListCreateView.
    def get_permissions(self) -> list[BasePermission]:
        codename = "seating.manage" if self.request.method == "PUT" else "seating.view"
        return [HasPermission(codename)()]

    def get_queryset(self) -> QuerySet[VehicleType]:
        # Never a bare `queryset = VehicleType.objects.all()` class
        # attribute — see apps.network.views.RouteListCreateView's own
        # get_queryset() docstring for why that freezes empty forever.
        return VehicleType.objects.all()

    def get(self, request: Request, pk: str) -> Response:
        vehicle_type = get_object_or_404(self.get_queryset(), pk=pk)
        seats = Seat.objects.filter(vehicle_type=vehicle_type)
        return Response(SeatSerializer(seats, many=True).data)

    @extend_schema(request=VehicleTypeSeatsUpdateSerializer, responses=SeatSerializer(many=True))
    def put(self, request: Request, pk: str) -> Response:
        vehicle_type = get_object_or_404(self.get_queryset(), pk=pk)
        serializer = VehicleTypeSeatsUpdateSerializer(
            data=request.data, context={"vehicle_type": vehicle_type}
        )
        serializer.is_valid(raise_exception=True)
        user = request.user
        assert isinstance(user, User)
        try:
            seats = replace_vehicle_type_seats(
                vehicle_type=vehicle_type,
                seats=serializer.validated_data["seats"],
                updated_by=user,
            )
        except SeatsInUse as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_409_CONFLICT)
        return Response(SeatSerializer(seats, many=True).data)


@extend_schema(request=VehicleTypeSeatsGenerateSerializer, responses=SeatSerializer(many=True))
class VehicleTypeSeatsGenerateView(generics.GenericAPIView[VehicleType]):
    """POST /vehicle-types/{id}/seats/generate/ — the UI-facing seat-map
    builder endpoint (docs/specs/8-seat-map-generation.md). Computes a
    full rows x columns layout and writes it via the same
    replace_vehicle_type_seats() the lower-level PUT above uses."""

    permission_classes = [HasPermission("seating.manage")]
    pagination_class = None  # see VehicleTypeSeatsView's identical fix, same root cause

    def get_queryset(self) -> QuerySet[VehicleType]:
        return VehicleType.objects.all()

    def post(self, request: Request, pk: str) -> Response:
        vehicle_type = get_object_or_404(self.get_queryset(), pk=pk)
        serializer = VehicleTypeSeatsGenerateSerializer(
            data=request.data, context={"vehicle_type": vehicle_type}
        )
        serializer.is_valid(raise_exception=True)
        user = request.user
        assert isinstance(user, User)
        layout = generate_seat_layout(
            rows=serializer.validated_data["rows"],
            columns=serializer.validated_data["columns"],
            aisle_after_column=serializer.validated_data.get("aisle_after_column"),
            numbering_scheme=serializer.validated_data["numbering_scheme"],
        )
        try:
            seats = replace_vehicle_type_seats(
                vehicle_type=vehicle_type, seats=layout, updated_by=user
            )
        except SeatsInUse as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_409_CONFLICT)
        return Response(SeatSerializer(seats, many=True).data)


@extend_schema(
    parameters=[
        OpenApiParameter("from_stop", str, OpenApiParameter.QUERY, required=True),
        OpenApiParameter("to_stop", str, OpenApiParameter.QUERY, required=True),
    ],
    responses=SeatAvailabilitySerializer(many=True),
)
class TripAvailabilityView(APIView):
    """Seat availability for a Trip's segment —
    docs/specs/4-fares-seating-booking.md §3. Not permission-codename
    gated: same IsAuthenticated + ordinary tenancy scoping as
    apps.fares.views.TripFareView, and for the same reason (passengers
    have no Role — see that view's own docstring)."""

    permission_classes = [IsAuthenticated]

    def get(self, request: Request, pk: str) -> Response:
        trip = get_object_or_404(
            Trip.objects.select_related("route", "vehicle__vehicle_type"), pk=pk
        )
        query = TripAvailabilityQuerySerializer(data=request.query_params)
        query.is_valid(raise_exception=True)
        availability = get_availability(
            trip=trip,
            from_stop=query.validated_data["from_stop"],
            to_stop=query.validated_data["to_stop"],
        )
        return Response(SeatAvailabilitySerializer(availability, many=True).data)
