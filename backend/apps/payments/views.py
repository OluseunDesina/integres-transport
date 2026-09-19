"""Views for apps.payments — see docs/specs/5-payments-wallet-ledger.md."""

from typing import Any

from django.db.models import QuerySet
from django.shortcuts import get_object_or_404
from drf_spectacular.utils import OpenApiParameter, extend_schema, extend_schema_view
from rest_framework import generics, status
from rest_framework.permissions import AllowAny, BasePermission, IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.serializers import BaseSerializer
from rest_framework.views import APIView

from apps.analytics.filters import apply_to_payment_records, resolve_filters
from apps.businesses.models import Business
from apps.core.idempotency import IdempotencyKeyConflict
from apps.core.permissions import HasPermission, IsPlatformStaff
from apps.core.rls import platform_staff_bypass
from apps.identity.models import User
from apps.ledger.models import SettlementRun
from apps.ledger.services import SettlementRunAlreadyExists

from .models import PaymentIntent, PaystackAccount
from .psp.paystack import PaystackAPIError
from .serializers import (
    PaymentInitiateResponseSerializer,
    PaymentInitiateSerializer,
    PaymentIntentListQuerySerializer,
    PaymentIntentSerializer,
    PaystackAccountSerializer,
    SettlementRunListQuerySerializer,
    SettlementRunSerializer,
    SettlementRunTriggerSerializer,
)
from .services import (
    BookingNotPayable,
    InsufficientWalletBalance,
    PaymentAlreadyPending,
    PayoutDestinationNotConfigured,
    PspNotConfigured,
    configure_paystack_account,
    initiate_payment,
    initiate_payment_with_wallet,
    initiate_wallet_topup,
    process_paystack_webhook,
    trigger_settlement_run,
)

_IDEMPOTENCY_KEY_PARAM = OpenApiParameter(
    "Idempotency-Key",
    str,
    OpenApiParameter.HEADER,
    required=True,
    description="Client-generated key. A retried request with the same key and body "
    "returns the original PaymentIntent rather than initiating a second payment.",
)
_BUSINESS_QUERY_PARAM = OpenApiParameter(
    "business", str, OpenApiParameter.QUERY, required=False, description="Filter to one Business."
)
_PAYMENT_SEARCH_QUERY_PARAM = OpenApiParameter(
    "search",
    str,
    OpenApiParameter.QUERY,
    required=False,
    description="Case-insensitive substring match on the PSP reference.",
)
_STATUS_QUERY_PARAM = OpenApiParameter(
    "status", str, OpenApiParameter.QUERY, required=False, description="Filter to one status."
)


@extend_schema_view(
    get=extend_schema(responses=PaystackAccountSerializer),
    patch=extend_schema(request=PaystackAccountSerializer, responses=PaystackAccountSerializer),
)
class PaystackAccountConfigView(generics.GenericAPIView[Business]):
    """GET/PATCH /super-admin/businesses/{id}/paystack-account/ —
    super-admin-only, mirrors
    apps.businesses.views.BusinessSeatHoldView exactly, adjusted for a
    OneToOne-related model that may not have a row yet
    (`configure_paystack_account` uses `update_or_create`).

    GET added in Phase 5 frontend Slice C — the PATCH-only original
    left a config screen with no way to show "already configured"
    state or avoid a blind overwrite. Returns a distinct 404 message
    when the Business exists but has no `PaystackAccount` row yet
    (vs. a plain "Not found." when the Business itself doesn't exist),
    so the frontend can render "not yet configured" as an expected,
    non-error state."""

    permission_classes = [IsPlatformStaff]
    http_method_names = ["get", "patch"]

    def get_queryset(self) -> QuerySet[Business]:
        return Business.all_objects.all()

    def get(self, request: Request, pk: str) -> Response:
        business = get_object_or_404(self.get_queryset(), pk=pk)
        try:
            account = PaystackAccount.all_objects.get(business=business)
        except PaystackAccount.DoesNotExist:
            return Response(
                {"detail": "No Paystack account configured for this business yet."},
                status=status.HTTP_404_NOT_FOUND,
            )
        return Response(PaystackAccountSerializer(account).data)

    def patch(self, request: Request, pk: str) -> Response:
        business = get_object_or_404(self.get_queryset(), pk=pk)
        serializer = PaystackAccountSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = request.user
        assert isinstance(user, User)
        account = configure_paystack_account(
            business=business,
            bank_code=serializer.validated_data.get("bank_code", ""),
            account_number=serializer.validated_data.get("account_number", ""),
            account_name=serializer.validated_data.get("account_name", ""),
            recipient_code=serializer.validated_data.get("recipient_code", ""),
            is_active=serializer.validated_data.get("is_active", True),
            updated_by=user,
        )
        return Response(PaystackAccountSerializer(account).data)


@extend_schema_view(
    get=extend_schema(
        parameters=[
            _BUSINESS_QUERY_PARAM,
            _STATUS_QUERY_PARAM,
            _PAYMENT_SEARCH_QUERY_PARAM,
        ]
    ),
    post=extend_schema(
        request=PaymentInitiateSerializer,
        responses=PaymentInitiateResponseSerializer,
        parameters=[_IDEMPOTENCY_KEY_PARAM],
    ),
)
class PaymentListCreateView(generics.ListCreateAPIView[PaymentIntent]):
    """GET is staff-only visibility (`payments.view`); POST is the
    passenger-facing payment-initiation endpoint — `IsAuthenticated`
    only, no Role/Permission gate, matching
    `apps.booking.views.BookingListCreateView`'s exact same POST/GET
    split for the identical reason (passengers have no Role,
    docs/adr/0003)."""

    def get_permissions(self) -> list[BasePermission]:
        if self.request.method == "POST":
            return [IsAuthenticated()]
        return [HasPermission("payments.view")()]

    def get_serializer_class(self) -> type[BaseSerializer[PaymentIntent]]:
        return (
            PaymentInitiateSerializer if self.request.method == "POST" else PaymentIntentSerializer
        )

    def get_queryset(self) -> QuerySet[PaymentIntent]:
        """Filtered through `apps.analytics.filters`, the same module
        `GET /analytics/payments/summary/` uses.

        That shared path is the point: the metrics strip above this
        table and the table itself now cannot describe different rows,
        because there is only one place the filtering happens
        (docs/specs/16-operational-analytics.md). A divergence would be
        one bug to find, not two.

        `search` stays local — it is a free-text convenience for looking
        up a disputed reference, not a dimension anything aggregates by.

        **`apply_to_payment_records`, not `apply_to_payments`.** The
        record-grain wrapper skips the rolling default period unless the
        caller actually named one. Calling the aggregate function here
        was a real, shipped bug: from slice 2 until slice 4 this list —
        a support and dispute screen — silently showed only the last 30
        days, with no chip, no message and no error saying so. The
        summary strip above it is still bounded, because an aggregate
        with no period is meaningless; a paginated list is already
        bounded by its own pagination.
        """
        queryset = PaymentIntent.objects.select_related("booking", "business", "passenger").all()
        queryset = apply_to_payment_records(queryset, resolve_filters(self.request.query_params))

        query = PaymentIntentListQuerySerializer(data=self.request.query_params.dict())
        query.is_valid(raise_exception=True)
        search = query.validated_data.get("search", "").strip()
        if search:
            queryset = queryset.filter(psp_reference__icontains=search)

        return queryset

    def create(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        idempotency_key = request.headers.get("Idempotency-Key")
        if not idempotency_key:
            return Response(
                {"detail": "Idempotency-Key header is required."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        serializer = PaymentInitiateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        booking = serializer.validated_data.get("booking_id")
        use_wallet_balance = serializer.validated_data.get("use_wallet_balance", False)
        wallet_topup = serializer.validated_data.get("wallet_topup")
        user = request.user
        assert isinstance(user, User)
        try:
            if booking is not None:
                if booking.passenger_id != user.id:
                    return Response(
                        {"detail": "You cannot pay for another passenger's booking."},
                        status=status.HTTP_403_FORBIDDEN,
                    )
                if use_wallet_balance:
                    intent = initiate_payment_with_wallet(
                        booking=booking, passenger=user, idempotency_key=idempotency_key
                    )
                else:
                    intent = initiate_payment(
                        booking=booking, passenger=user, idempotency_key=idempotency_key
                    )
            else:
                intent = initiate_wallet_topup(
                    business=wallet_topup["business_id"],
                    passenger=user,
                    amount=wallet_topup["amount"],
                    idempotency_key=idempotency_key,
                )
        except PspNotConfigured as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_404_NOT_FOUND)
        except (PaymentAlreadyPending, BookingNotPayable, IdempotencyKeyConflict) as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_409_CONFLICT)
        except InsufficientWalletBalance as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_409_CONFLICT)
        except PaystackAPIError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_502_BAD_GATEWAY)
        return Response(
            PaymentInitiateResponseSerializer(intent).data, status=status.HTTP_201_CREATED
        )


class PaymentIntentMineView(generics.ListAPIView[PaymentIntent]):
    """GET /payments/mine/ — the passenger's own PaymentIntents.

    `all_objects` + `platform_staff_bypass()`, not `.objects` —
    docs/adr/0009, same reasoning as `apps.booking.views.BookingMineView`:
    a marketplace-initiated PaymentIntent's `client` is the operator's,
    not the passenger's own. `super().list()` already does the actual
    queryset evaluation (pagination/serialization); wrapping it is
    enough, no custom `list()` body needed here the way `BookingMineView`
    has one for unrelated reasons.
    """

    permission_classes = [IsAuthenticated]
    serializer_class = PaymentIntentSerializer

    def get_queryset(self) -> QuerySet[PaymentIntent]:
        user = self.request.user
        assert isinstance(user, User)
        return PaymentIntent.all_objects.select_related(
            "booking", "business", "passenger"
        ).filter(passenger=user, deleted_at__isnull=True)

    def list(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        with platform_staff_bypass():
            return super().list(request, *args, **kwargs)


class PaymentIntentDetailView(generics.RetrieveAPIView[PaymentIntent]):
    """GET /payments/{id}/ — own PaymentIntent only. See
    `PaymentIntentMineView`'s own docstring for the `all_objects` +
    `platform_staff_bypass()` reasoning."""

    permission_classes = [IsAuthenticated]
    serializer_class = PaymentIntentSerializer

    def get_queryset(self) -> QuerySet[PaymentIntent]:
        user = self.request.user
        assert isinstance(user, User)
        return PaymentIntent.all_objects.select_related(
            "booking", "business", "passenger"
        ).filter(passenger=user, deleted_at__isnull=True)

    def retrieve(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        with platform_staff_bypass():
            return super().retrieve(request, *args, **kwargs)


@extend_schema_view(
    get=extend_schema(parameters=[_BUSINESS_QUERY_PARAM]),
    post=extend_schema(request=SettlementRunTriggerSerializer, responses=SettlementRunSerializer),
)
class SettlementRunListCreateView(generics.ListCreateAPIView[SettlementRun]):
    """GET/POST /settlement-runs/ — Phase 5 Slice 3. IsPlatformStaff-
    gated, not a Role/Permission codename: a payout is a platform
    financial operation, not client self-service — mirrors
    apps.businesses.views.BusinessSeatHoldView's/
    PaystackAccountConfigView's own gating exactly (the spec's own API
    surface note)."""

    permission_classes = [IsPlatformStaff]

    def get_queryset(self) -> QuerySet[SettlementRun]:
        queryset = SettlementRun.all_objects.select_related("business", "initiated_by").all()
        query = SettlementRunListQuerySerializer(data=self.request.query_params)
        query.is_valid(raise_exception=True)
        business = query.validated_data.get("business")
        if business is not None:
            queryset = queryset.filter(business=business)
        return queryset

    def get_serializer_class(self) -> type[BaseSerializer[SettlementRun]]:
        return (
            SettlementRunTriggerSerializer
            if self.request.method == "POST"
            else SettlementRunSerializer
        )

    def create(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        serializer = SettlementRunTriggerSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = request.user
        assert isinstance(user, User)
        try:
            run = trigger_settlement_run(
                business=serializer.validated_data["business"],
                period_start=serializer.validated_data["period_start"],
                period_end=serializer.validated_data["period_end"],
                initiated_by=user,
            )
        except PayoutDestinationNotConfigured as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_404_NOT_FOUND)
        except SettlementRunAlreadyExists as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_409_CONFLICT)
        except PaystackAPIError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_502_BAD_GATEWAY)
        return Response(SettlementRunSerializer(run).data, status=status.HTTP_201_CREATED)


@extend_schema(exclude=True)
class PaystackWebhookView(APIView):
    """POST /webhooks/paystack/ — public, unauthenticated (Paystack
    itself is the only real caller). `raw_body = request.body` is read
    as the very first line, before any other request access — DRF's
    `.data` consumes the underlying stream, and a later `.body` access
    after that raises `RawPostDataException`.

    Excluded from the generated OpenAPI schema (`exclude=True`): its
    request body is Paystack's own opaque webhook payload, not a shape
    this codebase defines or any frontend client here ever calls —
    documenting it would need a fabricated request serializer for a
    consumer that doesn't exist. Without this, drf-spectacular can't
    guess a serializer for a plain `APIView` and errors on every schema
    generation (`./scripts/check_openapi_drift.sh` and CI's own
    `spectacular --validate` step both run this)."""

    permission_classes = [AllowAny]
    authentication_classes: list[Any] = []

    def post(self, request: Request) -> Response:
        raw_body = request.body
        signature = request.headers.get("X-Paystack-Signature", "")
        result_status = process_paystack_webhook(raw_body=raw_body, signature=signature)
        return Response(status=result_status)
