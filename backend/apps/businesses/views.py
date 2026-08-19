from django.db.models import QuerySet
from django.shortcuts import get_object_or_404
from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework import generics
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.permissions import BasePermission
from rest_framework.request import Request
from rest_framework.response import Response

from apps.core.permissions import HasPermission, IsPlatformStaff
from apps.identity.models import User

from .models import Business
from .serializers import (
    BusinessKybQueueSerializer,
    BusinessSeatHoldSerializer,
    BusinessSerializer,
    BusinessSuperAdminSerializer,
    KybDecisionSerializer,
    KybDocumentSerializer,
)
from .services import decide_business_kyb, submit_kyb_document, update_business_seat_hold_minutes


def _own_businesses() -> QuerySet[Business]:
    # `Business.objects` (TenantScopedManager) resolves the active client
    # from a contextvar *at call time* — it must never be assigned to a
    # bare `queryset = ...` class attribute, since that would evaluate
    # once at import time (before any request has set a tenancy context)
    # and freeze to an empty queryset forever. Every view below calls
    # this as a method instead, so it re-resolves per request.
    return Business.objects.all()


class BusinessListCreateView(generics.ListCreateAPIView[Business]):
    # §4 gates GET (client.view) and POST (business.manage) differently
    # on the same URL — ListCreateAPIView combines both HTTP methods in
    # one class, so this branches per-method instead of a single
    # permission_classes list.
    serializer_class = BusinessSerializer

    def get_permissions(self) -> list[BasePermission]:
        codename = "business.manage" if self.request.method == "POST" else "client.view"
        return [HasPermission(codename)()]

    def get_queryset(self) -> QuerySet[Business]:
        return _own_businesses()


class BusinessUpdateView(generics.UpdateAPIView[Business]):
    permission_classes = [HasPermission("business.manage")]
    serializer_class = BusinessSerializer
    http_method_names = ["patch"]

    def get_queryset(self) -> QuerySet[Business]:
        return _own_businesses()


@extend_schema(request=KybDocumentSerializer, responses=KybDocumentSerializer)
class KybDocumentUploadView(generics.GenericAPIView[Business]):
    # kyb.submit, not business.manage — the permission seeded specifically
    # for this endpoint ("Upload KYB documents for a Business",
    # apps/identity/migrations/0003_seed_permissions.py) was never wired
    # up here. No observable effect today (Owner/Manager hold both,
    # Staff holds neither), but this is what the seeded codename is for.
    permission_classes = [HasPermission("kyb.submit")]
    parser_classes = [MultiPartParser, FormParser]

    def get_queryset(self) -> QuerySet[Business]:
        return _own_businesses()

    def post(self, request: Request, business_id: str) -> Response:
        business = get_object_or_404(Business, pk=business_id)

        serializer = KybDocumentSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        user = request.user
        assert isinstance(user, User)
        document = submit_kyb_document(
            business=business,
            document_type=serializer.validated_data["document_type"],
            file=serializer.validated_data["file"],
            uploaded_by=user,
        )
        return Response(KybDocumentSerializer(document).data, status=201)


@extend_schema(request=BusinessSeatHoldSerializer, responses=BusinessSeatHoldSerializer)
class BusinessSeatHoldView(generics.GenericAPIView[Business]):
    """Super-admin-only — docs/adr/0004. Deliberately not part of
    BusinessUpdateView's client-admin PATCH path; see
    Business.seat_hold_minutes's own docstring for why."""

    permission_classes = [IsPlatformStaff]
    http_method_names = ["patch"]

    def get_queryset(self) -> QuerySet[Business]:
        return Business.all_objects.all()

    def patch(self, request: Request, pk: str) -> Response:
        business = get_object_or_404(self.get_queryset(), pk=pk)
        serializer = BusinessSeatHoldSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = request.user
        assert isinstance(user, User)
        updated = update_business_seat_hold_minutes(
            business=business,
            seat_hold_minutes=serializer.validated_data["seat_hold_minutes"],
            updated_by=user,
        )
        return Response(BusinessSeatHoldSerializer(updated).data)


@extend_schema(
    parameters=[
        OpenApiParameter(
            "search",
            str,
            OpenApiParameter.QUERY,
            required=False,
            description="Filter by Business name (icontains).",
        )
    ],
    responses=BusinessSuperAdminSerializer,
)
class BusinessSuperAdminListView(generics.ListAPIView[Business]):
    """GET /super-admin/businesses/ — cross-client Business search for
    platform staff, Phase 5 frontend Slice C. Needed before either of
    that slice's two other endpoints (Paystack account config,
    settlement-run trigger) are usable: neither the tenant-scoped
    `GET /businesses/` nor the kyb_status-filtered `KybQueueListView`
    let platform staff find an arbitrary, already-approved Business."""

    permission_classes = [IsPlatformStaff]
    serializer_class = BusinessSuperAdminSerializer

    def get_queryset(self) -> QuerySet[Business]:
        queryset = Business.all_objects.select_related("client").all()
        search = self.request.query_params.get("search", "").strip()
        if search:
            queryset = queryset.filter(name__icontains=search)
        return queryset


@extend_schema(responses=BusinessKybQueueSerializer)
class KybQueueListView(generics.ListAPIView[Business]):
    permission_classes = [IsPlatformStaff]
    serializer_class = BusinessKybQueueSerializer
    # select_related("client"): BusinessKybQueueSerializer.client_name
    # reads obj.client.name per row — without this, that's a second N+1
    # alongside the one fixed in get_documents (found in the same
    # Phase 1 self-check query-count audit).
    queryset = Business.all_objects.filter(
        kyb_status=Business.KybStatus.SUBMITTED
    ).select_related("client")


@extend_schema(request=KybDecisionSerializer, responses=BusinessKybQueueSerializer)
class KybDecideView(generics.GenericAPIView[Business]):
    permission_classes = [IsPlatformStaff]
    queryset = Business.all_objects.all()

    def post(self, request: Request, business_id: str) -> Response:
        business = get_object_or_404(Business.all_objects, pk=business_id)
        serializer = KybDecisionSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        user = request.user
        assert isinstance(user, User)
        updated = decide_business_kyb(
            business=business,
            decision=serializer.validated_data["decision"],
            reason=serializer.validated_data.get("reason", ""),
            decided_by=user,
        )
        return Response(BusinessKybQueueSerializer(updated).data)
