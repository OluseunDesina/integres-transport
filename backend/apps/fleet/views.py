from django.db.models import Q, QuerySet
from drf_spectacular.utils import OpenApiParameter, extend_schema, extend_schema_view
from rest_framework import generics
from rest_framework.permissions import BasePermission
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.serializers import BaseSerializer

from apps.core.permissions import HasPermission

from .models import Driver, Vehicle, VehicleType
from .serializers import (
    DriverCreateSerializer,
    DriverSerializer,
    FleetListQuerySerializer,
    VehicleCreateSerializer,
    VehicleSerializer,
    VehicleTypeCreateSerializer,
    VehicleTypeSerializer,
)

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
    description="Case-insensitive substring match. Vehicle types match on "
    "name; vehicles on registration number; drivers on name, phone or "
    "licence number.",
)

_IS_ACTIVE_QUERY_PARAM = OpenApiParameter(
    "is_active",
    bool,
    OpenApiParameter.QUERY,
    required=False,
    description="Filter to active or inactive rows. Omit for both.",
)

_LIST_QUERY_PARAMS = [_BUSINESS_QUERY_PARAM, _SEARCH_QUERY_PARAM, _IS_ACTIVE_QUERY_PARAM]


def _as_plain_dict(params: dict) -> dict:
    """A QueryDict as an ordinary dict — see the note in
    `_apply_list_query` for why that conversion is not cosmetic."""
    return params.dict() if hasattr(params, "dict") else dict(params)


def _apply_list_query(queryset: QuerySet, params: dict, search_fields: list[str]) -> QuerySet:
    """Applies `?business=&search=&is_active=` to a list queryset.

    Replaces the former `_filter_by_business`, which did only the first.
    `search_fields` belongs to the view rather than the serializer: the
    query's *shape* is shared across this app, what "search" means is
    not.

    Every clause narrows, which is why no search term can reach another
    Client's rows — the queryset handed in is already tenant-scoped by
    `Model.objects`, and by RLS underneath it, independently.
    """
    # `params.dict()`, not the QueryDict itself, and this is load-bearing.
    # DRF's `BooleanField.get_value` treats any mapping with `getlist` —
    # which every QueryDict has — as HTML form input, and an HTML form
    # omits an unchecked checkbox entirely. So it substitutes `False` for
    # a *missing* boolean rather than leaving it absent, and `is_active`
    # would silently filter every list to inactive rows on every request
    # that never mentioned it. Caught by three previously-green
    # `?business=` tests going empty the moment this param was added.
    query = FleetListQuerySerializer(data=_as_plain_dict(params))
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

    is_active = query.validated_data.get("is_active")
    if is_active is not None:
        queryset = queryset.filter(is_active=is_active)

    return queryset


@extend_schema_view(
    get=extend_schema(parameters=_LIST_QUERY_PARAMS),
    post=extend_schema(request=VehicleTypeCreateSerializer, responses=VehicleTypeSerializer),
)
class VehicleTypeListCreateView(generics.ListCreateAPIView[VehicleType]):
    def get_permissions(self) -> list[BasePermission]:
        codename = "fleet.manage" if self.request.method == "POST" else "fleet.view"
        return [HasPermission(codename)()]

    def get_queryset(self) -> QuerySet[VehicleType]:
        queryset = VehicleType.objects.select_related("business").all()
        return _apply_list_query(queryset, self.request.query_params, ["name"])

    def get_serializer_class(self) -> type[BaseSerializer[VehicleType]]:
        return (
            VehicleTypeCreateSerializer
            if self.request.method == "POST"
            else VehicleTypeSerializer
        )

    def create(self, request: Request, *args: object, **kwargs: object) -> Response:
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        vehicle_type = serializer.save()
        return Response(VehicleTypeSerializer(vehicle_type).data, status=201)


class VehicleTypeUpdateView(generics.UpdateAPIView[VehicleType]):
    permission_classes = [HasPermission("fleet.manage")]
    serializer_class = VehicleTypeSerializer
    http_method_names = ["patch"]

    def get_queryset(self) -> QuerySet[VehicleType]:
        return VehicleType.objects.all()


@extend_schema_view(
    get=extend_schema(parameters=_LIST_QUERY_PARAMS),
    post=extend_schema(request=VehicleCreateSerializer, responses=VehicleSerializer),
)
class VehicleListCreateView(generics.ListCreateAPIView[Vehicle]):
    def get_permissions(self) -> list[BasePermission]:
        codename = "fleet.manage" if self.request.method == "POST" else "fleet.view"
        return [HasPermission(codename)()]

    def get_queryset(self) -> QuerySet[Vehicle]:
        queryset = Vehicle.objects.select_related("business", "vehicle_type").all()
        return _apply_list_query(queryset, self.request.query_params, ["registration_number"])

    def get_serializer_class(self) -> type[BaseSerializer[Vehicle]]:
        return VehicleCreateSerializer if self.request.method == "POST" else VehicleSerializer

    def create(self, request: Request, *args: object, **kwargs: object) -> Response:
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        vehicle = serializer.save()
        return Response(VehicleSerializer(vehicle).data, status=201)


class VehicleUpdateView(generics.UpdateAPIView[Vehicle]):
    permission_classes = [HasPermission("fleet.manage")]
    serializer_class = VehicleSerializer
    http_method_names = ["patch"]

    def get_queryset(self) -> QuerySet[Vehicle]:
        return Vehicle.objects.all()


@extend_schema_view(
    get=extend_schema(parameters=_LIST_QUERY_PARAMS),
    post=extend_schema(request=DriverCreateSerializer, responses=DriverSerializer),
)
class DriverListCreateView(generics.ListCreateAPIView[Driver]):
    def get_permissions(self) -> list[BasePermission]:
        codename = "fleet.manage" if self.request.method == "POST" else "fleet.view"
        return [HasPermission(codename)()]

    def get_queryset(self) -> QuerySet[Driver]:
        queryset = Driver.objects.select_related("business").all()
        return _apply_list_query(
            queryset, self.request.query_params, ["name", "phone", "license_number"]
        )

    def get_serializer_class(self) -> type[BaseSerializer[Driver]]:
        return DriverCreateSerializer if self.request.method == "POST" else DriverSerializer

    def create(self, request: Request, *args: object, **kwargs: object) -> Response:
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        driver = serializer.save()
        return Response(DriverSerializer(driver).data, status=201)


class DriverUpdateView(generics.UpdateAPIView[Driver]):
    permission_classes = [HasPermission("fleet.manage")]
    serializer_class = DriverSerializer
    http_method_names = ["patch"]

    def get_queryset(self) -> QuerySet[Driver]:
        return Driver.objects.all()
