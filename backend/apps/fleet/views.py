from django.db.models import QuerySet
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


def _filter_by_business(queryset: QuerySet, params: dict) -> QuerySet:
    query = FleetListQuerySerializer(data=params)
    query.is_valid(raise_exception=True)
    business = query.validated_data.get("business")
    if business is not None:
        queryset = queryset.filter(business=business)
    return queryset


@extend_schema_view(
    get=extend_schema(parameters=[_BUSINESS_QUERY_PARAM]),
    post=extend_schema(request=VehicleTypeCreateSerializer, responses=VehicleTypeSerializer),
)
class VehicleTypeListCreateView(generics.ListCreateAPIView[VehicleType]):
    def get_permissions(self) -> list[BasePermission]:
        codename = "fleet.manage" if self.request.method == "POST" else "fleet.view"
        return [HasPermission(codename)()]

    def get_queryset(self) -> QuerySet[VehicleType]:
        queryset = VehicleType.objects.select_related("business").all()
        return _filter_by_business(queryset, self.request.query_params)

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
    get=extend_schema(parameters=[_BUSINESS_QUERY_PARAM]),
    post=extend_schema(request=VehicleCreateSerializer, responses=VehicleSerializer),
)
class VehicleListCreateView(generics.ListCreateAPIView[Vehicle]):
    def get_permissions(self) -> list[BasePermission]:
        codename = "fleet.manage" if self.request.method == "POST" else "fleet.view"
        return [HasPermission(codename)()]

    def get_queryset(self) -> QuerySet[Vehicle]:
        queryset = Vehicle.objects.select_related("business", "vehicle_type").all()
        return _filter_by_business(queryset, self.request.query_params)

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
    get=extend_schema(parameters=[_BUSINESS_QUERY_PARAM]),
    post=extend_schema(request=DriverCreateSerializer, responses=DriverSerializer),
)
class DriverListCreateView(generics.ListCreateAPIView[Driver]):
    def get_permissions(self) -> list[BasePermission]:
        codename = "fleet.manage" if self.request.method == "POST" else "fleet.view"
        return [HasPermission(codename)()]

    def get_queryset(self) -> QuerySet[Driver]:
        queryset = Driver.objects.select_related("business").all()
        return _filter_by_business(queryset, self.request.query_params)

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
