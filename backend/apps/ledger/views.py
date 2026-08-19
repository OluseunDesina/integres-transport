"""Views for apps.ledger — see docs/specs/5-payments-wallet-ledger.md.
Staff-facing, read-only this slice — LedgerAccount/JournalEntry rows are
only ever written by apps.ledger.services, never by a view."""

from collections import defaultdict
from typing import Any

from django.db.models import QuerySet
from drf_spectacular.utils import OpenApiParameter, extend_schema, extend_schema_view
from rest_framework import generics
from rest_framework.request import Request
from rest_framework.response import Response

from apps.core.permissions import HasPermission

from .models import JournalEntry, JournalLine, LedgerAccount
from .serializers import (
    JournalEntryListQuerySerializer,
    JournalEntrySerializer,
    LedgerAccountListQuerySerializer,
    LedgerAccountSerializer,
)

_BUSINESS_QUERY_PARAM = OpenApiParameter(
    "business", str, OpenApiParameter.QUERY, required=True, description="Filter to one Business."
)
_ACCOUNT_QUERY_PARAM = OpenApiParameter(
    "account",
    str,
    OpenApiParameter.QUERY,
    required=False,
    description="Filter to entries touching one LedgerAccount.",
)


@extend_schema_view(get=extend_schema(parameters=[_BUSINESS_QUERY_PARAM]))
class LedgerAccountListView(generics.ListAPIView[LedgerAccount]):
    """GET /ledger/accounts/?business= — a Business's LedgerAccount
    rows. Requires `ledger.view`. `business` is resolved via
    `LedgerAccountListQuerySerializer._resolve_business`, itself scoped
    by `Business.objects`'s `TenantScopedManager` — a `business`
    belonging to another Client doesn't resolve at all (400), the same
    `DoesNotExist -> ValidationError` shape
    `apps.tapngo.serializers._resolve_trip` already establishes for the
    same kind of query-param FK lookup."""

    permission_classes = [HasPermission("ledger.view")]
    serializer_class = LedgerAccountSerializer

    def get_queryset(self) -> QuerySet[LedgerAccount]:
        query = LedgerAccountListQuerySerializer(data=self.request.query_params)
        query.is_valid(raise_exception=True)
        business = query.validated_data["business"]
        return LedgerAccount.objects.filter(business=business).select_related(
            "business", "passenger"
        )


@extend_schema_view(get=extend_schema(parameters=[_BUSINESS_QUERY_PARAM, _ACCOUNT_QUERY_PARAM]))
class JournalEntryListView(generics.ListAPIView[JournalEntry]):
    """GET /ledger/entries/?business=&account= — a Business's
    JournalEntry rows, each with its lines nested. Requires
    `ledger.view`.

    `list()` is overridden (rather than relying on DRF's default
    single-queryset render) to batch exactly one extra `JournalLine`
    query for the whole page, grouped by `journal_entry_id` and handed
    to the serializer via context — the N+1-avoidance mechanism
    `JournalEntrySerializer.get_lines` depends on, necessary because
    `JournalLine.journal_entry` has no reverse accessor to
    `prefetch_related` through."""

    permission_classes = [HasPermission("ledger.view")]
    serializer_class = JournalEntrySerializer

    def get_queryset(self) -> QuerySet[JournalEntry]:
        query = JournalEntryListQuerySerializer(data=self.request.query_params)
        query.is_valid(raise_exception=True)
        business = query.validated_data["business"]
        queryset = JournalEntry.objects.filter(business=business).select_related("business")
        account = query.validated_data.get("account")
        if account is not None:
            entry_ids = JournalLine.objects.filter(account=account).values_list(
                "journal_entry_id", flat=True
            )
            queryset = queryset.filter(id__in=list(entry_ids))
        return queryset

    def list(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        queryset = self.filter_queryset(self.get_queryset())
        page = self.paginate_queryset(queryset)
        entries = page if page is not None else list(queryset)

        # No `select_related("account")` — see
        # `JournalLineNestedSerializer`'s own docstring: a JOIN against
        # the RLS-protected `LedgerAccount` table would silently drop
        # any line whose account isn't visible under the current
        # session (the platform commission account, chiefly), even
        # though the `JournalLine` row itself is. `account_id` alone is
        # already present on every row with no join needed.
        lines = JournalLine.objects.filter(journal_entry__in=entries)
        lines_by_entry: dict[str, list[JournalLine]] = defaultdict(list)
        for line in lines:
            lines_by_entry[str(line.journal_entry_id)].append(line)

        context = {**self.get_serializer_context(), "lines_by_entry": lines_by_entry}
        serializer = self.get_serializer(entries, many=True, context=context)
        if page is not None:
            return self.get_paginated_response(serializer.data)
        return Response(serializer.data)
