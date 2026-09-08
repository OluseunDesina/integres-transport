from django.db.models import Count, Q, QuerySet
from django.shortcuts import get_object_or_404
from drf_spectacular.utils import OpenApiParameter, extend_schema, extend_schema_view
from rest_framework import generics, status
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
    RouteDetailSerializer,
    RouteSerializer,
    RouteStatusSerializer,
    RouteStopsUpdateSerializer,
    StopCreateSerializer,
    StopSerializer,
)
from .services import (
    RouteHasFutureTrips,
    RouteNotReadyToActivate,
    RouteTransitionIllegal,
    duplicate_route,
    set_route_status,
    set_route_stops,
)

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

_SEARCH_QUERY_PARAM = OpenApiParameter(
    "search",
    str,
    OpenApiParameter.QUERY,
    required=False,
    description="Case-insensitive substring match. Routes match on name "
    "or code; stops on name or address.",
)

_IS_ACTIVE_QUERY_PARAM = OpenApiParameter(
    "is_active",
    bool,
    OpenApiParameter.QUERY,
    required=False,
    description="Filter to active or inactive rows. Omit for both.",
)

# docs/specs/19-route-lifecycle.md. Route dropped `is_active` for a
# four-state `status`; Stop kept its boolean (no lifecycle for Stop —
# see that spec's own non-goals), so the two list views now diverge on
# this one param and can no longer share `_LIST_QUERY_PARAMS`.
_STATUS_QUERY_PARAM = OpenApiParameter(
    "status",
    str,
    OpenApiParameter.QUERY,
    required=False,
    description="Filter to a single status. Omit to see every status "
    "except archived.",
)

_ROUTE_LIST_QUERY_PARAMS = [_BUSINESS_QUERY_PARAM, _SEARCH_QUERY_PARAM, _STATUS_QUERY_PARAM]
_STOP_LIST_QUERY_PARAMS = [_BUSINESS_QUERY_PARAM, _SEARCH_QUERY_PARAM, _IS_ACTIVE_QUERY_PARAM]


def _as_plain_dict(params: dict) -> dict:
    """A QueryDict as an ordinary dict — see the note in
    `_apply_list_query` for why that conversion is not cosmetic."""
    return params.dict() if hasattr(params, "dict") else dict(params)


def _apply_list_query(queryset: QuerySet, params: dict, search_fields: list[str]) -> QuerySet:
    """Applies `?business=&search=` to a list queryset — the two params
    Route and Stop lists still share. Each model's own extra filter
    (Route's `status`, Stop's `is_active`) is applied by that view's own
    wrapper below, not here — see `_apply_route_list_query` /
    `_apply_stop_list_query`.

    `search_fields` is the view's, not the serializer's: the shape of the
    query is shared across this app, but what "search" means is not — a
    Route is found by its name or code, a Stop by its name or address.

    Every clause here narrows. That matters more than it looks: it is why
    no search term can reach another Client's rows, since the queryset
    handed in is already tenant-scoped by `Model.objects` (and by RLS
    underneath it, independently).
    """
    # `params.dict()`, not the QueryDict itself, and this is load-bearing.
    # DRF's `BooleanField.get_value` treats any mapping with `getlist` —
    # which every QueryDict has — as HTML form input, and an HTML form
    # omits an unchecked checkbox entirely. So it substitutes `False` for
    # a *missing* boolean rather than leaving it absent, and `is_active`
    # would silently filter every list to inactive rows on every request
    # that never mentioned it. Caught by three previously-green
    # `?business=` tests going empty the moment this param was added.
    query = NetworkListQuerySerializer(data=_as_plain_dict(params))
    query.is_valid(raise_exception=True)

    business = query.validated_data.get("business")
    if business is not None:
        queryset = queryset.filter(business=business)

    search = query.validated_data.get("search", "").strip()
    if search:
        matches = Q()
        for field in search_fields:
            matches |= Q(**{f"{field}__icontains": search})
        queryset = queryset.filter(matches)

    return queryset


def _apply_route_list_query(queryset: QuerySet[Route], params: dict) -> QuerySet[Route]:
    """`?business=&search=&status=` for the staff Route list. `status`
    defaults to "everything except archived" rather than Stop's plain
    is_active narrowing — docs/specs/19-route-lifecycle.md's API surface
    table: "excludes archived unless asked"."""
    queryset = _apply_list_query(queryset, params, ["name", "code"])
    query = NetworkListQuerySerializer(data=_as_plain_dict(params))
    query.is_valid(raise_exception=True)
    requested_status = query.validated_data.get("status")
    if requested_status is not None:
        return queryset.filter(status=requested_status)
    return queryset.exclude(status=Route.Status.ARCHIVED)


def _apply_stop_list_query(queryset: QuerySet[Stop], params: dict) -> QuerySet[Stop]:
    """`?business=&search=&is_active=` for the Stop list — Stop kept its
    plain boolean (docs/specs/19-route-lifecycle.md's non-goals)."""
    queryset = _apply_list_query(queryset, params, ["name", "address"])
    query = NetworkListQuerySerializer(data=_as_plain_dict(params))
    query.is_valid(raise_exception=True)
    is_active = query.validated_data.get("is_active")
    if is_active is not None:
        return queryset.filter(is_active=is_active)
    return queryset


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
    get=extend_schema(parameters=_ROUTE_LIST_QUERY_PARAMS),
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
        return _apply_route_list_query(queryset, self.request.query_params)

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
        # docs/specs/19-route-lifecycle.md: `active` specifically, never
        # "anything that is not archived" — a draft or inactive route
        # must be as invisible here as an archived one.
        queryset = Route.objects.select_related("business").filter(
            status=Route.Status.ACTIVE, id__in=bookable
        )
        # `_as_plain_dict` even though this view reads only `business` —
        # the QueryDict/BooleanField trap documented in
        # `_apply_list_query` is latent the moment anyone reads another
        # field here.
        query = NetworkListQuerySerializer(data=_as_plain_dict(self.request.query_params))
        query.is_valid(raise_exception=True)
        business = query.validated_data.get("business")
        if business is not None:
            queryset = queryset.filter(business=business)
        return queryset


@extend_schema_view(
    get=extend_schema(responses=RouteDetailSerializer),
    patch=extend_schema(responses=RouteSerializer),
)
class RouteDetailView(generics.RetrieveUpdateAPIView[Route]):
    """GET (detail) + PATCH (mutable fields) on `/routes/{id}/` —
    docs/specs/19-route-lifecycle.md. One resource, one path; the two
    methods differ in permission and response shape the same way
    `RouteListCreateView` already splits GET from POST."""

    http_method_names = ["get", "patch"]

    def get_permissions(self) -> list[BasePermission]:
        codename = "network.view" if self.request.method == "GET" else "network.manage"
        return [HasPermission(codename)()]

    def get_queryset(self) -> QuerySet[Route]:
        return Route.objects.select_related("business").all()

    def get_serializer_class(self) -> type[BaseSerializer[Route]]:
        return RouteDetailSerializer if self.request.method == "GET" else RouteSerializer


@extend_schema(request=RouteStatusSerializer, responses=RouteSerializer)
class RouteStatusView(generics.GenericAPIView[Route]):
    """POST /routes/{id}/status/ — the only way `Route.status` moves.
    Mirrors `apps.scheduling.views.TripStatusView`'s shape."""

    permission_classes = [HasPermission("network.manage")]
    serializer_class = RouteStatusSerializer

    def get_queryset(self) -> QuerySet[Route]:
        return Route.objects.all()

    def post(self, request: Request, pk: str) -> Response:
        route = get_object_or_404(self.get_queryset(), pk=pk)
        serializer = RouteStatusSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = request.user
        assert isinstance(user, User)
        try:
            updated = set_route_status(
                route=route,
                new_status=serializer.validated_data["status"],
                actor=user,
                reason=serializer.validated_data.get("reason", ""),
            )
        except RouteTransitionIllegal as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        except (RouteNotReadyToActivate, RouteHasFutureTrips) as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_409_CONFLICT)
        return Response(RouteSerializer(updated).data)


@extend_schema(request=None, responses=RouteSerializer)
class RouteDuplicateView(generics.GenericAPIView[Route]):
    """POST /routes/{id}/duplicate/ — returns the new draft route.
    docs/specs/19-route-lifecycle.md: no request body, since there is
    nothing to choose — the copy is always a draft with a suffixed name
    and no code."""

    permission_classes = [HasPermission("network.manage")]
    serializer_class = RouteSerializer

    def get_queryset(self) -> QuerySet[Route]:
        return Route.objects.all()

    def post(self, request: Request, pk: str) -> Response:
        route = get_object_or_404(self.get_queryset(), pk=pk)
        user = request.user
        assert isinstance(user, User)
        copy = duplicate_route(route=route, duplicated_by=user)
        return Response(RouteSerializer(copy).data, status=status.HTTP_201_CREATED)


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
    get=extend_schema(parameters=_STOP_LIST_QUERY_PARAMS),
    post=extend_schema(request=StopCreateSerializer, responses=StopSerializer),
)
class StopListCreateView(generics.ListCreateAPIView[Stop]):
    def get_permissions(self) -> list[BasePermission]:
        codename = "network.manage" if self.request.method == "POST" else "network.view"
        return [HasPermission(codename)()]

    def get_queryset(self) -> QuerySet[Stop]:
        queryset = Stop.objects.select_related("business").all()
        return _apply_stop_list_query(queryset, self.request.query_params)

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
