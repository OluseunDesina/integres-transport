from django.db.models import QuerySet
from django.shortcuts import get_object_or_404
from drf_spectacular.utils import OpenApiParameter, extend_schema, extend_schema_view
from rest_framework import generics
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.permissions import BasePermission
from rest_framework.request import Request
from rest_framework.response import Response

from apps.core.permissions import HasPermission, IsPlatformStaff
from apps.identity.models import User

from .models import Business, Director, KybDocument
from .serializers import (
    BusinessKybQueueSerializer,
    BusinessListQuerySerializer,
    BusinessSeatHoldSerializer,
    BusinessSerializer,
    BusinessSuperAdminQuerySerializer,
    BusinessSuperAdminSerializer,
    DirectorSerializer,
    KybDecisionSerializer,
    KybDocumentSerializer,
)
from .services import (
    create_director,
    decide_business_kyb,
    submit_kyb_document,
    update_business_seat_hold_minutes,
    update_director,
)


def _own_businesses() -> QuerySet[Business]:
    # `Business.objects` (TenantScopedManager) resolves the active client
    # from a contextvar *at call time* — it must never be assigned to a
    # bare `queryset = ...` class attribute, since that would evaluate
    # once at import time (before any request has set a tenancy context)
    # and freeze to an empty queryset forever. Every view below calls
    # this as a method instead, so it re-resolves per request.
    return Business.objects.all()


_OWN_BUSINESS_SEARCH_QUERY_PARAM = OpenApiParameter(
    "search",
    str,
    OpenApiParameter.QUERY,
    required=False,
    description="Case-insensitive substring match on the business name.",
)


@extend_schema_view(get=extend_schema(parameters=[_OWN_BUSINESS_SEARCH_QUERY_PARAM]))
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
        queryset = _own_businesses()

        query = BusinessListQuerySerializer(data=self.request.query_params.dict())
        query.is_valid(raise_exception=True)
        search = query.validated_data.get("search", "").strip()
        if search:
            # `_own_businesses()` is already Client-scoped, and this only
            # narrows it.
            queryset = queryset.filter(name__icontains=search)

        return queryset


class BusinessUpdateView(generics.UpdateAPIView[Business]):
    permission_classes = [HasPermission("business.manage")]
    serializer_class = BusinessSerializer
    http_method_names = ["patch"]

    def get_queryset(self) -> QuerySet[Business]:
        return _own_businesses()


class DirectorListCreateView(generics.ListCreateAPIView[Director]):
    """docs/specs/11-kyb-directors.md. Gated per-method the same way
    BusinessListCreateView is, and on the same pair: reads are
    `client.view` (there is no `business.view` codename — `apps.businesses`
    seeds only a write one), writes are `business.manage`."""

    serializer_class = DirectorSerializer

    def get_permissions(self) -> list[BasePermission]:
        codename = "business.manage" if self.request.method == "POST" else "client.view"
        return [HasPermission(codename)()]

    def get_queryset(self) -> QuerySet[Director]:
        # A method, never a bare class attribute — see _own_businesses's
        # comment for the import-time-evaluation trap this avoids.
        return Director.objects.filter(business_id=self.kwargs["business_id"])

    def create(self, request: Request, *args: object, **kwargs: object) -> Response:
        # get_object_or_404 against the tenant-scoped manager: another
        # Client's business_id 404s here rather than leaking its
        # existence or letting a director be attached across tenants.
        business = get_object_or_404(_own_businesses(), pk=self.kwargs["business_id"])
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = request.user
        assert isinstance(user, User)
        director = create_director(
            business=business,
            full_name=serializer.validated_data["full_name"],
            id_type=serializer.validated_data["id_type"],
            id_number=serializer.validated_data.get("id_number", ""),
            created_by=user,
        )
        return Response(DirectorSerializer(director).data, status=201)


class DirectorUpdateView(generics.UpdateAPIView[Director]):
    permission_classes = [HasPermission("business.manage")]
    serializer_class = DirectorSerializer
    http_method_names = ["patch"]

    def get_queryset(self) -> QuerySet[Director]:
        return Director.objects.all()

    def patch(self, request: Request, pk: str) -> Response:
        director = get_object_or_404(self.get_queryset(), pk=pk)
        serializer = self.get_serializer(director, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        user = request.user
        assert isinstance(user, User)
        updated = update_director(
            director=director, updated_by=user, **serializer.validated_data
        )
        return Response(DirectorSerializer(updated).data)


@extend_schema_view(
    get=extend_schema(responses=KybDocumentSerializer(many=True)),
    post=extend_schema(request=KybDocumentSerializer, responses=KybDocumentSerializer),
)
class KybDocumentUploadView(generics.GenericAPIView[Business]):
    # POST is kyb.submit — the permission seeded specifically for this
    # endpoint ("Upload KYB documents for a Business",
    # apps/identity/migrations/0003_seed_permissions.py) was never wired
    # up here. No observable effect today (Owner/Manager hold both,
    # Staff holds neither), but this is what the seeded codename is for.
    #
    # GET is client.view, matching every other read in this app (there
    # is no `business.view` codename). It was added for the KYB screen
    # (docs/specs/11-kyb-directors.md): this endpoint was POST-only, so
    # a client-admin had no way to see which documents they had already
    # supplied — the screen could only ever offer another blank upload,
    # never show outstanding vs done. Not enumerated in that spec's own
    # API table, but required by its Form design section.
    #
    # `pagination_class = None` matters: GET returns a bare list, and
    # without this drf-spectacular documents it as the paginated
    # `{count, results}` envelope every other list endpoint uses — so
    # the *generated types would not match what the endpoint actually
    # returns*. Same reasoning and same fix as
    # apps.seating.views.VehicleTypeSeatsView. A business's KYB packet
    # is a handful of rows the screen always wants in full; paginating
    # it would be ceremony for no gain.
    pagination_class = None
    parser_classes = [MultiPartParser, FormParser]

    def get_permissions(self) -> list[BasePermission]:
        codename = "kyb.submit" if self.request.method == "POST" else "client.view"
        return [HasPermission(codename)()]

    def get_queryset(self) -> QuerySet[Business]:
        return _own_businesses()

    def get(self, request: Request, business_id: str) -> Response:
        # get_object_or_404 against the tenant-scoped manager first, so
        # another Client's business_id 404s rather than returning an
        # empty list that reads as "no documents yet".
        business = get_object_or_404(_own_businesses(), pk=business_id)
        documents = KybDocument.objects.filter(business=business)
        return Response(KybDocumentSerializer(documents, many=True).data)

    def post(self, request: Request, business_id: str) -> Response:
        business = get_object_or_404(Business, pk=business_id)

        # `business` in context so the serializer can reject a director
        # belonging to a different Business — see its validate().
        serializer = KybDocumentSerializer(data=request.data, context={"business": business})
        serializer.is_valid(raise_exception=True)

        user = request.user
        assert isinstance(user, User)
        document = submit_kyb_document(
            business=business,
            document_type=serializer.validated_data["document_type"],
            file=serializer.validated_data["file"],
            director=serializer.validated_data.get("director"),
            uploaded_by=user,
        )
        return Response(KybDocumentSerializer(document).data, status=201)


@extend_schema(request=BusinessSeatHoldSerializer, responses=BusinessSeatHoldSerializer)
class BusinessSeatHoldView(generics.GenericAPIView[Business]):
    """Super-admin-only — docs/adr/0004. Deliberately not part of
    BusinessUpdateView's client-admin PATCH path; see
    Business.seat_hold_minutes's own docstring for why.

    GET added alongside the original PATCH-only shape (a UI gap: no way
    to read the current value before editing it) — same precedent
    `PaystackAccountConfigView` already set. Unlike that view, no
    404-for-unconfigured branch is needed: `seat_hold_minutes` is a
    plain non-nullable field with a model default, so every Business
    always has a value, never an "unconfigured" state."""

    permission_classes = [IsPlatformStaff]
    http_method_names = ["get", "patch"]

    def get_queryset(self) -> QuerySet[Business]:
        return Business.all_objects.all()

    def get(self, request: Request, pk: str) -> Response:
        business = get_object_or_404(self.get_queryset(), pk=pk)
        return Response(BusinessSeatHoldSerializer(business).data)

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
        ),
        OpenApiParameter(
            "kyb_status",
            str,
            OpenApiParameter.QUERY,
            required=False,
            description="Filter by KYB review status.",
        ),
        OpenApiParameter(
            "vertical",
            str,
            OpenApiParameter.QUERY,
            required=False,
            description="Filter by business vertical.",
        ),
        OpenApiParameter(
            "is_active",
            str,
            OpenApiParameter.QUERY,
            required=False,
            enum=["true", "false"],
            description="Filter by active status.",
        ),
    ],
    responses=BusinessSuperAdminSerializer,
)
class BusinessSuperAdminListView(generics.ListAPIView[Business]):
    """GET /super-admin/businesses/ — cross-client Business search for
    platform staff, Phase 5 frontend Slice C. Needed before either of
    that slice's two other endpoints (Paystack account config,
    settlement-run trigger) are usable: neither the tenant-scoped
    `GET /businesses/` nor the kyb_status-filtered `KybQueueListView`
    let platform staff find an arbitrary, already-approved Business.

    Gained `kyb_status`/`vertical`/`is_active` filtering once the
    super-admin frontend's separate KYB queue page was folded into this
    one list (both showed `Business` rows with no way to cross-filter
    between the two screens). `KybQueueListView`/`KybDecideView` below
    are unchanged — this list is now the only page that renders them,
    but the decide endpoint still does the actual mutation."""

    permission_classes = [IsPlatformStaff]
    serializer_class = BusinessSuperAdminSerializer

    def get_queryset(self) -> QuerySet[Business]:
        queryset = Business.all_objects.select_related("client").all()
        query = BusinessSuperAdminQuerySerializer(data=self.request.query_params)
        query.is_valid(raise_exception=True)
        search = query.validated_data.get("search", "").strip()
        if search:
            queryset = queryset.filter(name__icontains=search)
        if "kyb_status" in query.validated_data:
            queryset = queryset.filter(kyb_status=query.validated_data["kyb_status"])
        if "vertical" in query.validated_data:
            queryset = queryset.filter(vertical=query.validated_data["vertical"])
        if "is_active" in query.validated_data:
            queryset = queryset.filter(is_active=query.validated_data["is_active"] == "true")
        return queryset


@extend_schema(responses=BusinessKybQueueSerializer)
@extend_schema_view(get=extend_schema(parameters=[_OWN_BUSINESS_SEARCH_QUERY_PARAM]))
class KybQueueListView(generics.ListAPIView[Business]):
    permission_classes = [IsPlatformStaff]
    serializer_class = BusinessKybQueueSerializer

    def get_queryset(self) -> QuerySet[Business]:
        # select_related("client"): BusinessKybQueueSerializer.client_name
        # reads obj.client.name per row — without this, that's a second
        # N+1 alongside the one fixed in get_documents (found in the same
        # Phase 1 self-check query-count audit).
        # `order_by("kyb_submitted_at")` — oldest submission first, i.e.
        # FIFO, the business that has been waiting longest gets reviewed
        # first. Without it this inherits `Business.Meta.ordering =
        # ["-created_at"]`, which ranks a review queue by when each
        # business was *created*: one registered months ago but submitted
        # for KYB this morning sank below everything created after it, no
        # matter how long it had been waiting. Creation time and
        # submission time are different facts, and only the second one is
        # what a queue is about.
        queryset = (
            Business.all_objects.filter(kyb_status=Business.KybStatus.SUBMITTED)
            .select_related("client")
            .order_by("kyb_submitted_at")
        )

        query = BusinessListQuerySerializer(data=self.request.query_params.dict())
        query.is_valid(raise_exception=True)
        search = query.validated_data.get("search", "").strip()
        if search:
            # No queue has grown large enough (self-check
            # 2026-09-12-specs19-21's F7) that a reviewer could actually
            # find a specific submission by paging through FIFO order —
            # name is the one thing every row's own heading already shows.
            queryset = queryset.filter(name__icontains=search)

        return queryset


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
