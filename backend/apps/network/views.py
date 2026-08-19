from django.db.models import Count, QuerySet
from django.shortcuts import get_object_or_404
from drf_spectacular.utils import OpenApiParameter, extend_schema, extend_schema_view
from rest_framework import generics
from rest_framework.permissions import BasePermission, IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.serializers import BaseSerializer

from apps.core.permissions import HasPermission
from apps.identity.models import User

from .models import Route, RouteStop, Stop
from .serializers import (
    NetworkListQuerySerializer,
    RouteBrowseSerializer,
    RouteCreateSerializer,
    RouteSerializer,
    RouteStopsUpdateSerializer,
    StopCreateSerializer,
    StopSerializer,
)
from .services import set_route_stops

# get_queryset() isn't schema-introspected by drf-spectacular for query
# params (unlike filter_backends) — without this explicit parameter
# list, the generated schema.ts wouldn't type `business` as a valid
# query param on GET, and frontend call sites would need an `as` cast.
_BUSINESS_QUERY_PARAM = OpenApiParameter(
    "business",
    str,
    OpenApiParameter.QUERY,
    required=False,
    description="Filter to a single Business's rows. An unknown or "
    "another Client's Business id returns 400.",
)


# get_serializer_class() correctly picks RouteCreateSerializer for
# request-body validation, but drf-spectacular also uses it to guess the
# *response* schema for every method — this view's POST actually responds
# with RouteSerializer's shape (create() below), not RouteCreateSerializer's.
# `@extend_schema` decorating create() directly is silently ignored by
# drf-spectacular for a ListCreateAPIView's overridden create() method (verified
# empirically — the generated schema kept using RouteCreateSerializer for the
# response regardless); `extend_schema_view`'s per-HTTP-verb class decorator is
# the mechanism that actually takes effect here.
@extend_schema_view(
    get=extend_schema(parameters=[_BUSINESS_QUERY_PARAM]),
    post=extend_schema(request=RouteCreateSerializer, responses=RouteSerializer),
)
class RouteListCreateView(generics.ListCreateAPIView[Route]):
    # network.view (GET) / network.manage (POST) — same per-method
    # branching precedent as BusinessListCreateView.get_permissions().
    def get_permissions(self) -> list[BasePermission]:
        codename = "network.manage" if self.request.method == "POST" else "network.view"
        return [HasPermission(codename)()]

    def get_queryset(self) -> QuerySet[Route]:
        # Never a bare `queryset = Route.objects.all()` class attribute —
        # that freezes empty forever against TenantScopedManager. An
        # unknown/foreign ?business= id rejects with 400 (via
        # NetworkListQuerySerializer's tenant-scoped lookup) rather than
        # silently returning an empty or unfiltered list — see that
        # serializer's own docstring for why.
        queryset = Route.objects.select_related("business").all()
        query = NetworkListQuerySerializer(data=self.request.query_params)
        query.is_valid(raise_exception=True)
        business = query.validated_data.get("business")
        if business is not None:
            queryset = queryset.filter(business=business)
        return queryset

    def get_serializer_class(self) -> type[BaseSerializer[Route]]:
        return RouteCreateSerializer if self.request.method == "POST" else RouteSerializer

    def create(self, request: Request, *args: object, **kwargs: object) -> Response:
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        route = serializer.save()
        return Response(RouteSerializer(route).data, status=201)


@extend_schema(parameters=[_BUSINESS_QUERY_PARAM], responses=RouteBrowseSerializer(many=True))
class RouteBrowseView(generics.ListAPIView[Route]):
    """GET /routes/browse/ — the passenger-facing Route list, see
    docs/specs/4-fares-seating-booking-frontend.md §3.2.

    Deliberately a separate view class rather than RouteListCreateView
    with widened permissions: passengers hold no Role/Permission at all
    (docs/adr/0003), so this is IsAuthenticated + the ordinary tenancy
    scoping every BaseModel query already enforces — the same posture
    apps.fares.views.TripFareView and apps.seating.views.TripAvailabilityView
    already established. Keeping it separate also keeps the
    passenger-visible filtering (active Routes, bookable ones only) out
    of the staff view, and means no create/edit affordance can ever
    reach this URL.
    """

    permission_classes = [IsAuthenticated]
    serializer_class = RouteBrowseSerializer

    def get_queryset(self) -> QuerySet[Route]:
        # Never a bare `queryset = Route.objects.all()` class attribute —
        # see RouteListCreateView.get_queryset()'s own docstring.
        #
        # A Route needs >=2 active Stops to have any bookable segment at
        # all. That count has to come from a subquery rather than
        # `annotate(Count("routestop"))`: RouteStop.route is
        # related_name="+" (see models.py), so there is no reverse
        # accessor to aggregate over.
        bookable = (
            RouteStop.objects.filter(stop__is_active=True)
            .values("route")
            .annotate(active_stop_count=Count("id"))
            .filter(active_stop_count__gte=2)
            .values("route")
        )
        queryset = Route.objects.select_related("business").filter(is_active=True, id__in=bookable)
        query = NetworkListQuerySerializer(data=self.request.query_params)
        query.is_valid(raise_exception=True)
        business = query.validated_data.get("business")
        if business is not None:
            queryset = queryset.filter(business=business)
        return queryset


class RouteUpdateView(generics.UpdateAPIView[Route]):
    permission_classes = [HasPermission("network.manage")]
    serializer_class = RouteSerializer
    http_method_names = ["patch"]

    def get_queryset(self) -> QuerySet[Route]:
        return Route.objects.all()


@extend_schema(request=RouteStopsUpdateSerializer, responses=RouteSerializer)
class RouteStopsView(generics.GenericAPIView[Route]):
    permission_classes = [HasPermission("network.manage")]
    serializer_class = RouteStopsUpdateSerializer

    def get_queryset(self) -> QuerySet[Route]:
        return Route.objects.all()

    def put(self, request: Request, pk: str) -> Response:
        route = get_object_or_404(self.get_queryset(), pk=pk)
        serializer = RouteStopsUpdateSerializer(data=request.data, context={"route": route})
        serializer.is_valid(raise_exception=True)
        user = request.user
        assert isinstance(user, User)
        set_route_stops(route=route, stops=serializer.validated_data["stops"], updated_by=user)
        return Response(RouteSerializer(route).data)


@extend_schema_view(
    get=extend_schema(parameters=[_BUSINESS_QUERY_PARAM]),
    post=extend_schema(request=StopCreateSerializer, responses=StopSerializer),
)
class StopListCreateView(generics.ListCreateAPIView[Stop]):
    def get_permissions(self) -> list[BasePermission]:
        codename = "network.manage" if self.request.method == "POST" else "network.view"
        return [HasPermission(codename)()]

    def get_queryset(self) -> QuerySet[Stop]:
        queryset = Stop.objects.select_related("business").all()
        query = NetworkListQuerySerializer(data=self.request.query_params)
        query.is_valid(raise_exception=True)
        business = query.validated_data.get("business")
        if business is not None:
            queryset = queryset.filter(business=business)
        return queryset

    def get_serializer_class(self) -> type[BaseSerializer[Stop]]:
        return StopCreateSerializer if self.request.method == "POST" else StopSerializer

    def create(self, request: Request, *args: object, **kwargs: object) -> Response:
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        stop = serializer.save()
        return Response(StopSerializer(stop).data, status=201)


class StopUpdateView(generics.UpdateAPIView[Stop]):
    permission_classes = [HasPermission("network.manage")]
    serializer_class = StopSerializer
    http_method_names = ["patch"]

    def get_queryset(self) -> QuerySet[Stop]:
        return Stop.objects.all()
