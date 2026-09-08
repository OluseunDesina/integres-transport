"""CSV export of any analytics surface — see
docs/specs/16-operational-analytics.md's "Export" section.

This is the first non-JSON response this backend has ever returned.

## Why this is not a `StreamingHttpResponse`

The spec's own text says "streams via `StreamingHttpResponse` with a
server-side iterator". **It deliberately does not**, and that deviation
is the single most important thing in this module.

`apps.core.middleware.TenancyMiddleware` is the last entry in
`MIDDLEWARE`. It wraps `get_response(request)` in its own
`transaction.atomic()`, calls `set_rls_session_vars(...)` inside it, and
resets the Python tenancy contextvars in a `finally`. A streaming
response object is returned to the WSGI server *immediately* — so by the
time its body is iterated, the transaction has committed (taking the
transaction-local RLS session GUCs with it) and the contextvars are
already reset. A generator running querysets lazily would therefore
execute every one of them with **no tenancy context at all**:
`TenantScopedQuerySet` returns `self.none()`, RLS fails closed, and the
operator downloads a silently empty CSV that reports `200 OK`. That is
the exact class of quiet, plausible wrongness this whole spec exists to
prevent.

Rebuilding tenancy inside the generator was considered and rejected: it
would duplicate `TenancyMiddleware`, hold a database transaction open
for as long as the client's network takes to accept the body, and risk
leaking a contextvar onto a pooled worker thread if the download is
aborted mid-flight.

So **everything is materialised while the request's transaction and RLS
context are still live**, and the response is a plain, bounded
`HttpResponse`. `EXPORT_MAX_ROWS` bounds the body, so chunked transfer
would buy nothing. Read in context — "the point of doing this on the
server is that a browser export of a paginated list exports one page" —
the spec's "streams" means *the whole filtered set rather than one
page*, and that is preserved exactly.

Laziness is made structurally impossible rather than merely absent.
Three of the four guards fail at build time, since mypy runs in CI:

- `ExportSpec.rows` is typed `-> list[...]`. **A generator function does
  not satisfy that** — this is the primary guard.
- `RenderedExport.body` is a `str`, which cannot hide an iterator.
- `ExportView.get()` is annotated `-> HttpResponse`, and
  `StreamingHttpResponse` is not a subclass (both derive from
  `HttpResponseBase`).
- `tests/test_export_materialisation.py` walks this registry with no
  allowlist and asserts zero queries run while the body is read.

## What this module does and does not know

It turns rows into a file. It does **no** money arithmetic and issues no
queries: `apps.analytics.services` owns every money, rate and timezone
decision, so a value has already been through `_money()`/`_rate()`/
`_local_iso()` before it reaches `_cell`. `_cell` raises on a `Decimal`
to keep it that way — the CSV-side mirror of `as_decimal()` in the test
helpers, and of the emission boundary slice 3 had to add after money
shipped as floats.
"""

from __future__ import annotations

import csv
import io
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Any

from django.conf import settings
from rest_framework.renderers import BaseRenderer

from .filters import AnalyticsFilters, MissingExportFilter
from .services import (
    booking_rows,
    breakdown_by,
    manifest_rows,
    money_by_currency,
    revenue_trend,
    transaction_rows,
    trip_performance_rows,
)

#: Excel on Windows reads a BOM-less UTF-8 CSV as the ANSI code page,
#: turning every non-ASCII route or stop name into mojibake — and "Excel
#: opens this CSV" is the spec's stated reason for shipping CSV only.
BOM = "﻿"

#: Leading characters Excel and Google Sheets treat as the start of a
#: formula. Route names, stop names and cancellation reasons are
#: operator-entered free text that lands on another operator's machine,
#: so a cell starting with one of these is prefixed with an apostrophe.
_FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")


@dataclass(frozen=True)
class ExportSpec:
    """One downloadable resource.

    `rows` is typed as returning a **`list`**, not an iterable — see this
    module's docstring. It is the guard that makes a lazy row builder a
    mypy failure rather than an empty file.
    """

    resource: str
    #: The codename of the surface being exported, not a new
    #: `export.perform` one: a caller who can read a list can read it as
    #: a file, which is what the spec asks for.
    permission: str
    #: The header row, in order. Also the key order used per row, so a
    #: row dict carrying an unlisted key simply does not appear.
    columns: tuple[str, ...]
    rows: Callable[[AnalyticsFilters], list[dict[str, Any]]]
    #: `AnalyticsFilters` fields the caller **must** name, checked in
    #: `build_export` before any row is built.
    #:
    #: Declarative rather than a check inside a row builder, so the
    #: registry-driven tests stay registry-driven: they read this and
    #: supply what a resource asks for, instead of carrying an allowlist
    #: of resources to skip. A resource added later gets the same
    #: treatment for free — the shape
    #: `apps/core/tests/test_row_level_security.py` established.
    #:
    #: Only `manifest` uses it so far. Every other resource is bounded by
    #: a period; a manifest is bounded by a trip, and one with no trip is
    #: not a bigger export but a different question.
    required_filters: tuple[str, ...] = ()
    #: Whether this resource lists **everything** when the caller names
    #: no period.
    #:
    #: True for the two exports that mirror a paginated record list
    #: (`transactions`, `bookings`): those lists are bounded by their own
    #: pagination and must not be silently truncated to a rolling window
    #: nothing on screen mentions — see
    #: `apps.analytics.filters.apply_to_payment_records` for the shipped
    #: bug that rule exists to fix. Their exports are bounded by
    #: `EXPORT_MAX_ROWS` instead.
    #:
    #: False everywhere else. Aggregates are always bounded, because
    #: "revenue, all time" is not a question a dashboard asks; and
    #: `trip-performance` narrows on `service_date`, which is always
    #: windowed.
    #:
    #: The only thing this changes here is the **filename**, which must
    #: not claim a period the file does not respect.
    unbounded_without_period: bool = False


@dataclass(frozen=True)
class RenderedExport:
    filename: str
    body: str
    row_count: int


class ExportTooLarge(Exception):
    """Raised instead of truncating.

    A truncated file that reports `200 OK` looks complete and is not,
    which is worse than a refusal naming what to change.
    """

    def __init__(self, *, count: int, cap: int) -> None:
        self.count = count
        self.cap = cap
        super().__init__(
            f"This export would contain {count:,} rows, over the {cap:,}-row limit. "
            "Narrow the date range or the filters and try again."
        )


def _revenue_rows(filters: AnalyticsFilters) -> list[dict[str, Any]]:
    """`money_by_currency` with the period stamped onto each row.

    Aggregate resources carry `date_from`/`date_to`/`timezone` because
    they have no time dimension of their own; record-grain resources
    (`transactions`, `bookings`) carry their own timestamps instead. The
    rule is that a row is self-describing at its own grain — a saved file
    must still say what period it covers once its filename is gone.
    """
    return [{**_period_columns(filters), **row} for row in money_by_currency(filters)]


def _revenue_trend_rows(filters: AnalyticsFilters) -> list[dict[str, Any]]:
    return [
        {"timezone": filters.timezone, "granularity": filters.granularity, **row}
        for row in revenue_trend(filters)
    ]


def _dimension_revenue_rows(
    filters: AnalyticsFilters, field: str, label: str
) -> list[dict[str, Any]]:
    """`breakdown_by`, with its `amount` renamed `gross_amount`.

    A deliberate divergence from the JSON key. `breakdown_by` returns
    **gross**, while the `revenue` file's own `revenue` column is **net**
    — and two downloaded files with a column called `amount` meaning two
    different things is precisely the plausible wrongness this spec
    exists to prevent. A CSV header is the last place a reader can be
    told, so it says so.
    """
    return [
        {
            **_period_columns(filters),
            label: row[label],
            "currency": row["currency"],
            "gross_amount": row["amount"],
            "transaction_volume": row["transaction_volume"],
        }
        for row in breakdown_by(filters, field, label)
    ]


def _route_revenue_rows(filters: AnalyticsFilters) -> list[dict[str, Any]]:
    return _dimension_revenue_rows(filters, "booking__trip__route__name", "route")


def _trip_class_revenue_rows(filters: AnalyticsFilters) -> list[dict[str, Any]]:
    return _dimension_revenue_rows(filters, "booking__trip__trip_class", "trip_class")


def _period_columns(filters: AnalyticsFilters) -> dict[str, Any]:
    return {
        "date_from": filters.date_from,
        "date_to": filters.date_to,
        "timezone": filters.timezone,
    }


EXPORTS: dict[str, ExportSpec] = {
    "transactions": ExportSpec(
        resource="transactions",
        permission="payments.view",
        columns=(
            "created_at",
            "psp_reference",
            "business",
            "intent_type",
            "status",
            "channel",
            "currency",
            "amount",
            "wallet_component_amount",
            "total_paid",
            "route",
            "trip_class",
            "service_date",
            "requires_manual_refund",
            "passenger_id",
            "passenger_email",
            "passenger_name",
        ),
        rows=transaction_rows,
        unbounded_without_period=True,
    ),
    "bookings": ExportSpec(
        resource="bookings",
        permission="booking.view",
        columns=(
            "created_at",
            "booking_id",
            "business",
            "status",
            "trip_id",
            "service_date",
            "scheduled_departure_at",
            "route",
            "trip_class",
            "from_stop",
            "to_stop",
            "passenger_count",
            "currency",
            "total_amount",
            "passenger_id",
            "passenger_email",
            "passenger_name",
        ),
        rows=booking_rows,
        unbounded_without_period=True,
    ),
    # docs/specs/18-manifest-and-staff-booking.md slice 1. One shape for
    # both `kind`s rather than two resources: a caller downloading "the
    # manifest" should not have to know in advance how the trip collects
    # fares. Columns that do not apply to a kind are blank, and `kind`
    # itself is the first column so a spreadsheet says which it is.
    "manifest": ExportSpec(
        resource="manifest",
        permission="booking.view",
        columns=(
            "kind",
            "reference",
            "passenger_name",
            "seat_number",
            "board_stop",
            "alight_stop",
            "status",
            "booking_status",
            "currency",
            "fare",
            "boarded_at",
        ),
        rows=manifest_rows,
        required_filters=("trip",),
        # Bounded by its trip, not by a period — so a caller who names no
        # dates gets that trip's whole manifest rather than the rolling
        # window, which for a departure a fortnight ago would silently be
        # empty.
        unbounded_without_period=True,
    ),
    "revenue": ExportSpec(
        resource="revenue",
        permission="analytics.view",
        columns=(
            "date_from",
            "date_to",
            "timezone",
            "currency",
            "revenue",
            "gross",
            "commission",
            "transaction_volume",
            "average_ticket_value",
        ),
        rows=_revenue_rows,
    ),
    "revenue-trend": ExportSpec(
        resource="revenue-trend",
        permission="analytics.view",
        columns=("date", "timezone", "granularity", "currency", "amount"),
        rows=_revenue_trend_rows,
    ),
    "route-revenue": ExportSpec(
        resource="route-revenue",
        permission="analytics.view",
        columns=(
            "date_from",
            "date_to",
            "timezone",
            "route",
            "currency",
            "gross_amount",
            "transaction_volume",
        ),
        rows=_route_revenue_rows,
    ),
    "trip-class-revenue": ExportSpec(
        resource="trip-class-revenue",
        permission="analytics.view",
        columns=(
            "date_from",
            "date_to",
            "timezone",
            "trip_class",
            "currency",
            "gross_amount",
            "transaction_volume",
        ),
        rows=_trip_class_revenue_rows,
    ),
    "trip-performance": ExportSpec(
        resource="trip-performance",
        permission="analytics.view",
        columns=(
            "service_date",
            "trip_id",
            "route",
            "trip_class",
            "booking_mode",
            "status",
            "cancelled",
            "scheduled_departure_at",
            "actual_departure_at",
            "actual_arrival_at",
            "delay_minutes",
            "on_time",
            "total_seats",
            "seats_sold",
            "occupancy_rate",
            "currency",
            "revenue",
            "gross",
            "revenue_per_seat",
        ),
        rows=trip_performance_rows,
    ),
}


def build_export(*, spec: ExportSpec, filters: AnalyticsFilters) -> RenderedExport:
    """Materialise, check the cap, then render.

    The cap is checked **after** building the rows and before writing a
    byte, so the refusal is exact rather than an estimate. Building rows
    the caller will not receive is the price of never handing them a
    truncated file that looks whole.
    """
    missing = [name for name in spec.required_filters if getattr(filters, name, None) is None]
    if missing:
        raise MissingExportFilter(
            f"Name {' and '.join(f'a {name}' for name in missing)} to export the "
            f"{spec.resource}: {' '.join(f'?{name}=<id>' for name in missing)}."
        )

    rows = spec.rows(filters)
    cap = settings.EXPORT_MAX_ROWS
    if len(rows) > cap:
        raise ExportTooLarge(count=len(rows), cap=cap)

    buffer = io.StringIO()
    # RFC 4180 line endings, which is also what Excel wants. Explicit
    # rather than defaulted, because `csv`'s own default is
    # platform-independent and a reader would have to know that.
    writer = csv.writer(buffer, lineterminator="\r\n")
    writer.writerow(spec.columns)
    for row in rows:
        writer.writerow([_cell(row.get(column)) for column in spec.columns])

    return RenderedExport(
        filename=export_filename(spec=spec, filters=filters),
        body=BOM + buffer.getvalue(),
        row_count=len(rows),
    )


def export_filename(*, spec: ExportSpec, filters: AnalyticsFilters) -> str:
    """`integra-transactions-2026-08-01-to-2026-08-30.csv`,
    `integra-transactions-all.csv` when no period was named, or
    `integra-manifest-2026-09-07-a1b2c3d4.csv` for a trip-bounded one.

    **The name states what the file actually contains.** A bounded
    export is always named for its window — the *resolved* one, so a
    caller who named no period still sees the range really used. The two
    unbounded resources with no period named contain everything, and
    naming those for a 30-day window they do not respect would be the
    filename lying about the contents.

    **Every character comes from a fixed alphabet** (`a-z0-9-.`), so
    `Content-Disposition` needs no RFC 5987 `filename*` companion and
    cannot be broken by a quote, a slash or a non-ASCII character.
    Adding the Business name here is an obvious later request and this
    is the reason not to.
    """
    # A trip-bounded resource is named for its **trip**, not for a
    # period it does not respect. Downloading five departures' manifests
    # and getting five files called `integra-manifest-all.csv` is the
    # filename failing at the one job it has. The service date and a
    # short id, both from the fixed alphabet — the route name is not
    # used here for the reason the paragraph above gives.
    if filters.trip is not None and "trip" in spec.required_filters:
        return (
            f"integra-{spec.resource}-{filters.trip.service_date}"
            f"-{str(filters.trip.id)[:8]}.csv"
        )
    if spec.unbounded_without_period and not filters.period_explicit:
        return f"integra-{spec.resource}-all.csv"
    return f"integra-{spec.resource}-{filters.date_from}-to-{filters.date_to}.csv"


_DECIMAL_LIKE = re.compile(r"^[+-]?\d*\.?\d+$")


def _cell(value: Any) -> str:
    """One value as CSV text.

    - `None` is an **empty cell**, never `None`, `null`, `-` or `0`. A
      blank occupancy and a `0.000` occupancy must not look the same;
      that null discipline is the whole design of the endpoints these
      files mirror.
    - Booleans render `true`/`false`, matching the JSON.
    - A `Decimal` is a **`TypeError`**. Money reaches this module as a
      decimal string from `services._money()`; a bare `Decimal` here
      would mean that boundary had been bypassed, which is how analytics
      money shipped as floats in slice 2. Loud, not silent.
    - Anything that could be read as a formula is prefixed with an
      apostrophe — but only when it is not a number, so `-1500.00`
      survives intact.
    """
    if value is None:
        return ""
    if isinstance(value, Decimal):
        raise TypeError(
            "money must reach the CSV as a decimal string from services._money(), "
            f"not a Decimal: {value!r}"
        )
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, date):
        return value.isoformat()
    text = str(value)
    if text.startswith(_FORMULA_PREFIXES) and not _is_numeric(text):
        return f"'{text}"
    return text


def _is_numeric(text: str) -> bool:
    if not _DECIMAL_LIKE.match(text):
        return False
    try:
        Decimal(text)
    except InvalidOperation:  # pragma: no cover - the regex already excludes these
        return False
    return True


class CsvRenderer(BaseRenderer):
    """Present for **content negotiation, not rendering**.

    The success path returns a plain `HttpResponse` and never touches a
    renderer. But `DEFAULT_RENDERER_CLASSES` is `JSONRenderer` alone, and
    DRF runs `perform_content_negotiation()` in `initial()` — so a client
    sending `Accept: text/csv`, which is the most natural request there
    is for this endpoint, would get a **406 before `get()` ever ran**.
    Declaring this renderer is what makes that request acceptable.
    """

    media_type = "text/csv"
    format = "csv"
    charset = "utf-8"

    def render(
        self,
        data: Any,
        accepted_media_type: str | None = None,
        renderer_context: Mapping[str, Any] | None = None,
    ) -> bytes:
        # Only reachable if a future edit returns a DRF `Response` on the
        # success path; the error paths are JSON by construction.
        return str(data).encode(self.charset)
