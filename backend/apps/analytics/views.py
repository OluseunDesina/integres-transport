"""Read-only aggregation endpoints — see
docs/specs/16-operational-analytics.md.

Thin, as this repo's fat-services convention requires: each view
resolves the shared filter set, calls one function in `services.py`,
and returns it. Nothing here computes anything.

Permissions follow the spec's table exactly — `analytics.view` on
everything except the payments summary, which sits above the
transactions table and is gated on that table's own `payments.view`.
`analytics.view` is deliberately withheld from the Staff preset:
revenue totals are a different sensitivity from the operational lists
Staff needs.
"""

from __future__ import annotations

from typing import Any

from django.http import HttpResponse
from django.shortcuts import get_object_or_404
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, OpenApiResponse, extend_schema
from rest_framework import generics, status
from rest_framework.permissions import BasePermission, IsAuthenticated
from rest_framework.renderers import JSONRenderer
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle

from apps.core.audit import record_audit_event
from apps.core.permissions import HasPermission
from apps.scheduling.models import Trip

from .exports import EXPORTS, CsvRenderer, ExportTooLarge, build_export
from .filters import GRANULARITY_MAX_DAYS, MissingExportFilter, resolve_filters
from .serializers import (
    DashboardSerializer,
    PaymentSummarySerializer,
    RevenueReportSerializer,
    TripPerformanceSerializer,
)
from .services import dashboard, payments_summary, revenue_report, trip_performance

FILTER_PARAMS = [
    OpenApiParameter("business", str, OpenApiParameter.QUERY, description="Scope to one Business."),
    OpenApiParameter("route", str, OpenApiParameter.QUERY, description="Scope to one Route."),
    OpenApiParameter("trip_class", str, OpenApiParameter.QUERY, description="Scope to one class."),
    OpenApiParameter(
        "date_from",
        str,
        OpenApiParameter.QUERY,
        description="Inclusive start, as a local date in the resolved timezone. "
        "Defaults to 29 days before date_to.",
    ),
    OpenApiParameter(
        "date_to",
        str,
        OpenApiParameter.QUERY,
        description="Inclusive end, as a local date. Defaults to today.",
    ),
    OpenApiParameter("status", str, OpenApiParameter.QUERY, description="PaymentIntent status."),
    OpenApiParameter(
        "booking_status",
        str,
        OpenApiParameter.QUERY,
        description="Booking status. Separate from `status`, which is a PaymentIntent "
        "status — one field validated against two enums cannot validate either.",
    ),
    OpenApiParameter(
        "channel",
        str,
        OpenApiParameter.QUERY,
        description="Payment channel. `wallet` and `unknown` are accepted alongside "
        "the values Paystack reports.",
    ),
    OpenApiParameter(
        "granularity",
        str,
        OpenApiParameter.QUERY,
        enum=list(GRANULARITY_MAX_DAYS),
        description="Trend bucket size. Each has its own range cap; a longer range "
        "is a 400 naming the coarser granularity that would answer it.",
    ),
]


@extend_schema(parameters=FILTER_PARAMS, responses=DashboardSerializer)
class DashboardView(generics.GenericAPIView[Trip]):
    """GET /analytics/dashboard/ — the whole dashboard in one request.

    One envelope rather than a dozen endpoints the client fans out to
    and reduces locally: that pattern is the source of four separate
    production bugs recorded in CLAUDE.md, and on a dashboard it would
    produce silently wrong totals plausible enough that nobody checks.
    """

    permission_classes = [HasPermission("analytics.view")]
    serializer_class = DashboardSerializer

    def get(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        return Response(dashboard(resolve_filters(request.query_params)))


@extend_schema(parameters=FILTER_PARAMS, responses=RevenueReportSerializer)
class RevenueView(generics.GenericAPIView[Trip]):
    """GET /analytics/revenue/ — totals, trend and breakdowns."""

    permission_classes = [HasPermission("analytics.view")]
    serializer_class = RevenueReportSerializer

    def get(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        return Response(revenue_report(resolve_filters(request.query_params)))


@extend_schema(parameters=FILTER_PARAMS, responses=PaymentSummarySerializer)
class PaymentSummaryView(generics.GenericAPIView[Trip]):
    """GET /analytics/payments/summary/ — the metrics strip above the
    transactions table.

    Gated on `payments.view`, not `analytics.view`: it describes exactly
    the rows `GET /payments/` returns for the same filters, so anyone
    who may read that table may read its totals. It takes the identical
    filter set through the identical shared module, which is what makes
    the strip and the table incapable of disagreeing.
    """

    permission_classes = [HasPermission("payments.view")]
    serializer_class = PaymentSummarySerializer

    def get(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        return Response(payments_summary(resolve_filters(request.query_params)))


@extend_schema(responses=TripPerformanceSerializer)
class TripPerformanceView(generics.GenericAPIView[Trip]):
    """GET /analytics/trips/{id}/performance/ — one trip's operational
    and financial outcome.

    Takes no filter set: the trip *is* the scope. Resolved through
    `Trip.objects`, so another Client's trip is a 404 rather than a
    permission error — the same posture every other object-scoped
    endpoint in this backend takes.
    """

    permission_classes = [HasPermission("analytics.view")]
    serializer_class = TripPerformanceSerializer

    def get(self, request: Request, pk: str, *args: Any, **kwargs: Any) -> Response:
        trip = get_object_or_404(
            Trip.objects.select_related("route", "business", "vehicle__vehicle_type"), pk=pk
        )
        return Response(trip_performance(trip=trip))


@extend_schema(
    parameters=[
        OpenApiParameter(
            "resource",
            str,
            OpenApiParameter.PATH,
            enum=sorted(EXPORTS),
            description="Which surface to export.",
        ),
        *FILTER_PARAMS,
        OpenApiParameter(
            "Content-Disposition",
            str,
            OpenApiParameter.HEADER,
            response=[200],
            description='attachment; filename="integra-<resource>-<from>-to-<to>.csv"',
        ),
    ],
    responses={
        (200, "text/csv"): OpenApiResponse(
            response=OpenApiTypes.BINARY,
            description=(
                "The rows matching the current filters, as CSV — UTF-8 with a BOM, "
                "RFC 4180 line endings. Every row that matches, not one page."
            ),
        ),
        (400, "application/json"): OpenApiResponse(
            description="Invalid filters, or more rows than EXPORT_MAX_ROWS."
        ),
        (404, "application/json"): OpenApiResponse(description="Unknown export resource."),
    },
)
class ExportView(generics.GenericAPIView[Trip]):
    """GET /exports/{resource}/ — the caller's current filtered view, as CSV.

    **Everything is materialised inside `get()`**, while
    `TenancyMiddleware`'s transaction and RLS session variables are still
    live. See `apps/analytics/exports.py`'s module docstring for why this
    is not a `StreamingHttpResponse` — the short version is that a lazily
    iterated body runs its queries after the tenancy context is gone, and
    hands the operator a silently empty file that reports `200 OK`.

    **Not `exclude=True`.** The path has to reach the generated
    `schema.ts` so the frontend can download it through the typed client
    and inherit `authMiddleware`'s bearer token and 401-refresh; a raw
    `fetch` with a hand-attached header would re-create the stale-token
    bug docs/specs/13-session-resilience.md records.
    """

    # Present for content **negotiation**, not rendering: the success
    # path returns a plain HttpResponse and touches no renderer. But
    # DEFAULT_RENDERER_CLASSES is JSONRenderer alone and DRF negotiates
    # in `initial()`, so `Accept: text/csv` — the most natural request
    # there is for this endpoint — would be a 406 before `get()` ran.
    #
    # JSONRenderer stays **first**, deliberately: DRF picks the first
    # renderer for `Accept: */*`, and that is what the exception handler
    # uses for the 400/403/404 bodies. Reversed, an over-cap refusal
    # would be rendered as CSV.
    renderer_classes = [JSONRenderer, CsvRenderer]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "export"
    serializer_class = DashboardSerializer

    def get_permissions(self) -> list[BasePermission]:
        """The exported surface's own codename, per the spec — a caller
        who can read a list can read it as a file, so there is no new
        `export.perform` codename and no grant migration.

        `self.kwargs` is populated by `dispatch()` before `initial()`
        calls this, the same ordering `PaymentListCreateView.get_permissions`
        already relies on. An unknown resource falls back to
        `IsAuthenticated` so it is answered with the 404 it deserves
        rather than a misleading 403.
        """
        spec = EXPORTS.get(self.kwargs.get("resource", ""))
        if spec is None:
            return [IsAuthenticated()]
        return [HasPermission(spec.permission)()]

    def get(self, request: Request, resource: str, *args: Any, **kwargs: Any) -> HttpResponse:
        spec = EXPORTS.get(resource)
        if spec is None:
            return Response(
                {"detail": "Unknown export resource."}, status=status.HTTP_404_NOT_FOUND
            )

        filters = resolve_filters(request.query_params)
        try:
            export = build_export(spec=spec, filters=filters)
        except MissingExportFilter as exc:
            # A 400 naming the missing parameter, not an empty file. The
            # `manifest` resource is bounded by a trip rather than by a
            # period, and an export of every ticket ever issued is not a
            # reasonable reading of the omission.
            return Response({'detail': str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        except ExportTooLarge as exc:
            # No Content-Disposition on this path: a truncated file that
            # looks complete is the failure the cap exists to prevent, so
            # the refusal must not resemble a download at all.
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)

        # These files carry passenger names and emails, so they are a
        # customer list the moment they are saved. Recording who took one,
        # when, and over what period is the cheap half of taking that
        # seriously; `Cache-Control: no-store` (from NoStoreApiMiddleware)
        # is the other half, and is why a shared machine's browser cache
        # does not keep another operator's customers.
        record_audit_event(
            actor=request.user,
            action="analytics.export",
            resource=resource,
            row_count=export.row_count,
            date_from=filters.date_from,
            date_to=filters.date_to,
            timezone=filters.timezone,
            business_id=str(filters.business.id) if filters.business else None,
        )

        response = HttpResponse(export.body, content_type="text/csv; charset=utf-8")
        response["Content-Disposition"] = f'attachment; filename="{export.filename}"'
        return response
