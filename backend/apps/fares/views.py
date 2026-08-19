from django.db.models import QuerySet
from django.shortcuts import get_object_or_404
from drf_spectacular.utils import OpenApiParameter, extend_schema, extend_schema_view
from rest_framework import generics, status
from rest_framework.permissions import BasePermission, IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.serializers import BaseSerializer
from rest_framework.views import APIView

from apps.core.permissions import HasPermission
from apps.scheduling.models import Trip

from .models import FareRule, FareSegmentRule
from .serializers import (
    FareListQuerySerializer,
    FareRuleCreateSerializer,
    FareRuleSerializer,
    FareRuleSupersedeSerializer,
    FareSegmentRuleCreateSerializer,
    FareSegmentRuleSerializer,
    FareSegmentRuleSupersedeSerializer,
    TripFareQuerySerializer,
    TripFareQuoteSerializer,
)
from .services import FareNotConfigured, get_fare

# get_queryset() isn't schema-introspected by drf-spectacular for query
# params — see apps.network.views's own _BUSINESS_QUERY_PARAM comment
# for why this explicit list is needed for a correctly-typed schema.ts.
_LIST_QUERY_PARAMS = [
    OpenApiParameter(
        "business",
        str,
        OpenApiParameter.QUERY,
        required=False,
        description="Filter to a single Business's rows. An unknown or "
        "another Client's Business id returns 400.",
    ),
    OpenApiParameter(
        "route", str, OpenApiParameter.QUERY, required=False, description="Filter to one Route."
    ),
]


@extend_schema_view(
    get=extend_schema(parameters=_LIST_QUERY_PARAMS),
    post=extend_schema(request=FareRuleCreateSerializer, responses=FareRuleSerializer),
)
class FareRuleListCreateView(generics.ListCreateAPIView[FareRule]):
    def get_permissions(self) -> list[BasePermission]:
        codename = "fares.manage" if self.request.method == "POST" else "fares.view"
        return [HasPermission(codename)()]

    def get_queryset(self) -> QuerySet[FareRule]:
        # Never a bare `queryset = FareRule.objects.all()` class
        # attribute — see apps.network.views.RouteListCreateView's own
        # get_queryset() docstring for why that freezes empty forever.
        queryset = FareRule.objects.select_related("business", "route").all()
        query = FareListQuerySerializer(data=self.request.query_params)
        query.is_valid(raise_exception=True)
        business = query.validated_data.get("business")
        route = query.validated_data.get("route")
        if business is not None:
            queryset = queryset.filter(business=business)
        if route is not None:
            queryset = queryset.filter(route=route)
        return queryset

    def get_serializer_class(self) -> type[BaseSerializer[FareRule]]:
        return FareRuleCreateSerializer if self.request.method == "POST" else FareRuleSerializer

    def create(self, request: Request, *args: object, **kwargs: object) -> Response:
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        fare_rule = serializer.save()
        return Response(FareRuleSerializer(fare_rule).data, status=status.HTTP_201_CREATED)


@extend_schema(request=FareRuleSupersedeSerializer, responses=FareRuleSerializer)
class FareRuleUpdateView(generics.UpdateAPIView[FareRule]):
    """PATCH supersedes: closes the path's rule and returns the new
    successor (a different `id`). See FareRuleSupersedeSerializer."""

    permission_classes = [HasPermission("fares.manage")]
    serializer_class = FareRuleSupersedeSerializer
    http_method_names = ["patch"]

    def get_queryset(self) -> QuerySet[FareRule]:
        return FareRule.objects.all()

    def update(self, request: Request, *args: object, **kwargs: object) -> Response:
        instance = self.get_object()
        serializer = self.get_serializer(instance, data=request.data, partial=False)
        serializer.is_valid(raise_exception=True)
        successor = serializer.save()
        return Response(FareRuleSerializer(successor).data)


@extend_schema_view(
    get=extend_schema(parameters=_LIST_QUERY_PARAMS),
    post=extend_schema(
        request=FareSegmentRuleCreateSerializer, responses=FareSegmentRuleSerializer
    ),
)
class FareSegmentRuleListCreateView(generics.ListCreateAPIView[FareSegmentRule]):
    def get_permissions(self) -> list[BasePermission]:
        codename = "fares.manage" if self.request.method == "POST" else "fares.view"
        return [HasPermission(codename)()]

    def get_queryset(self) -> QuerySet[FareSegmentRule]:
        queryset = FareSegmentRule.objects.select_related(
            "business", "route", "from_stop", "to_stop"
        ).all()
        query = FareListQuerySerializer(data=self.request.query_params)
        query.is_valid(raise_exception=True)
        business = query.validated_data.get("business")
        route = query.validated_data.get("route")
        if business is not None:
            queryset = queryset.filter(business=business)
        if route is not None:
            queryset = queryset.filter(route=route)
        return queryset

    def get_serializer_class(self) -> type[BaseSerializer[FareSegmentRule]]:
        return (
            FareSegmentRuleCreateSerializer
            if self.request.method == "POST"
            else FareSegmentRuleSerializer
        )

    def create(self, request: Request, *args: object, **kwargs: object) -> Response:
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        fare_segment_rule = serializer.save()
        return Response(
            FareSegmentRuleSerializer(fare_segment_rule).data, status=status.HTTP_201_CREATED
        )


@extend_schema(request=FareSegmentRuleSupersedeSerializer, responses=FareSegmentRuleSerializer)
class FareSegmentRuleUpdateView(generics.UpdateAPIView[FareSegmentRule]):
    permission_classes = [HasPermission("fares.manage")]
    serializer_class = FareSegmentRuleSupersedeSerializer
    http_method_names = ["patch"]

    def get_queryset(self) -> QuerySet[FareSegmentRule]:
        return FareSegmentRule.objects.all()

    def update(self, request: Request, *args: object, **kwargs: object) -> Response:
        instance = self.get_object()
        serializer = self.get_serializer(instance, data=request.data, partial=False)
        serializer.is_valid(raise_exception=True)
        successor = serializer.save()
        return Response(FareSegmentRuleSerializer(successor).data)


@extend_schema(
    parameters=[
        OpenApiParameter("from_stop", str, OpenApiParameter.QUERY, required=True),
        OpenApiParameter("to_stop", str, OpenApiParameter.QUERY, required=True),
    ],
    responses=TripFareQuoteSerializer,
)
class TripFareView(APIView):
    """Fare quote for a Trip's segment —
    docs/specs/4-fares-seating-booking.md §3. Not permission-codename
    gated: passengers have no Role (see that spec's own note on this),
    so this is IsAuthenticated + the ordinary tenancy scoping every
    BaseModel query already enforces — the first phase where that
    distinction (staff permission-gated vs. passenger
    tenancy-scoped-only) actually matters."""

    permission_classes = [IsAuthenticated]

    def get(self, request: Request, pk: str) -> Response:
        trip = get_object_or_404(Trip.objects.select_related("route", "business"), pk=pk)
        query = TripFareQuerySerializer(data=request.query_params)
        query.is_valid(raise_exception=True)
        from_stop = query.validated_data["from_stop"]
        to_stop = query.validated_data["to_stop"]
        try:
            quote = get_fare(trip=trip, from_stop=from_stop, to_stop=to_stop)
        except FareNotConfigured as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_404_NOT_FOUND)
        return Response(
            TripFareQuoteSerializer({"amount": quote.amount, "currency": quote.currency}).data
        )
