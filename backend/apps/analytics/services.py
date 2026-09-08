"""Query-time aggregation over the operational tables — see
docs/specs/16-operational-analytics.md.

Three rules run through every function here, and each exists because
getting it wrong would be quiet rather than loud:

1. **Money is grouped by currency and never summed across it.**
   `Business.currency` is per-Business and a Client can run several;
   adding a Naira total to a Pula one produces a figure that is not
   money. Every monetary result is a list keyed by currency, which is a
   shape constraint rather than a UI convention.

2. **`LedgerAccount` is never joined.** Filtering or grouping on
   `account__account_type` would silently drop journal lines
   referencing the platform commission account whenever an ordinary
   Business's staff read them — that account has `client=None` and is
   invisible under their RLS session, and a JOIN against an invisible
   row drops the referencing row too. This is a real bug spec 5's own
   Slice 1 note records; account ids are resolved separately and
   filtered on as values.

3. **No `platform_staff_bypass()`.** Aggregates run under the caller's
   ordinary tenancy context. An aggregate that bypassed RLS would be
   the worst possible place to leak another Client's numbers.

**Trend buckets with data are the only ones emitted.** A `GROUP BY`
naturally omits empty buckets, and that is what the spec wants: a
zero-revenue day and a day before the Business existed must not render
identically. The client draws gaps.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Collection
from datetime import date, datetime
from decimal import ROUND_HALF_UP, Decimal
from typing import Any
from zoneinfo import ZoneInfo

from django.db.models import Count, Q, QuerySet, Sum
from django.db.models.functions import TruncDay, TruncMonth, TruncWeek
from django.utils import timezone as django_timezone

from apps.booking.models import Booking
from apps.incidents.models import OPEN_STATUSES, Incident
from apps.ledger.models import JournalEntry, JournalLine, LedgerAccount
from apps.network.models import Route
from apps.payments.models import PaymentIntent
from apps.scheduling.models import Trip
from apps.seating.models import Seat, SeatReservation
from apps.ticketing.capacity import OCCUPYING_STATUSES, get_capacity, is_open_seating
from apps.ticketing.models import Ticket

from .filters import (
    AnalyticsFilters,
    apply_to_booking_records,
    apply_to_bookings,
    apply_to_incidents,
    apply_to_payment_records,
    apply_to_payments,
    apply_to_trips,
)

ZERO = Decimal("0.00")

_TRUNC = {"day": TruncDay, "week": TruncWeek, "month": TruncMonth}

#: How many rows the dashboard's "recent" strips carry. Small on
#: purpose — this is a glance, not a list screen, and both have a real
#: paginated screen of their own to link to.
RECENT_LIMIT = 5


def _quantize(value: Decimal | None) -> Decimal:
    return (value or ZERO).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def _money(value: Decimal | None) -> str:
    """Every monetary value **leaves this module as a decimal string.**

    These endpoints return plain dicts, so nothing coerces their values
    the way a `ModelSerializer` field would — DRF's JSON encoder turns a
    bare `Decimal` into a **float**, and a float is not money. Two things
    went wrong before this existed, both found the moment slice 3's
    dashboard became the first consumer:

    1. The generated `schema.ts` declared these fields `string` (from the
       `DecimalField`s in `serializers.py`, which document the responses
       but never render them), while the wire carried a number. The
       frontend's `formatMoney` takes a string and rendered `NGN 2850`
       for `2850.0` — cents silently dropped, with the type system
       asserting it could not happen.
    2. Every other money field in this API is a string, deliberately, so
       decimals survive the wire intact. Analytics being the one
       exception would have made the dashboard the only screen that had
       to care which endpoint a number came from.

    `_quantize` stays `Decimal` because the arithmetic here needs it;
    this is the emission boundary.
    """
    return str(_quantize(value))


def _rate(value: Decimal | None) -> str | None:
    """Same, for the 3dp occupancy rate. `None` stays `None` — no
    denominator is not a rate of zero."""
    return None if value is None else str(value)


# --- the ledger side --------------------------------------------------


def _clearing_account_ids_for(business_ids: Collection[Any] | None) -> list[Any]:
    """The business-clearing accounts for these Businesses, as ids.

    Resolved separately and filtered on as values — see rule 2 in this
    module's docstring. These rows belong to the caller's own Client, so
    they are visible under an ordinary tenancy session; the commission
    account (`client=None`) is not, and is deliberately never read here.

    `None` means "every Business the caller can see", which is what an
    unscoped aggregate wants. This is the **only** place that knows how
    to find a clearing account without joining, so both the
    single-Business and the set-wise callers go through it.
    """
    queryset = LedgerAccount.objects.filter(
        account_type=LedgerAccount.AccountType.BUSINESS_CLEARING
    )
    if business_ids is not None:
        queryset = queryset.filter(business_id__in=list(business_ids))
    return list(queryset.values_list("id", flat=True))


def _clearing_account_ids(filters: AnalyticsFilters) -> list[Any]:
    return _clearing_account_ids_for(
        None if filters.business is None else [filters.business.id]
    )


def _payment_lines(filters: AnalyticsFilters) -> QuerySet[JournalLine]:
    """Journal lines belonging to payment entries in the period.

    Scoped on the **entry's** `created_at`, not the payment intent's:
    this is when the money actually moved, which is the only defensible
    period boundary for a revenue figure. The payments summary scopes on
    the intent instead, so that the strip and the table beneath it
    describe the same rows — the two answer different questions on
    purpose, and each is documented where it is computed.

    A route or trip-class filter has no path to a `JournalEntry`, so it
    narrows through the payment intents that own the entries. That extra
    id set is built only when one of those filters is present; the
    common case is two joins and no `IN` list.
    """
    lines = JournalLine.objects.filter(
        journal_entry__entry_type=JournalEntry.EntryType.PAYMENT,
        journal_entry__created_at__gte=filters.range_start,
        journal_entry__created_at__lt=filters.range_end,
    )
    if filters.business is not None:
        lines = lines.filter(journal_entry__business=filters.business)
    if filters.route is not None or filters.trip_class:
        intents = PaymentIntent.objects.filter(journal_entry__isnull=False)
        if filters.route is not None:
            intents = intents.filter(booking__trip__route=filters.route)
        if filters.trip_class:
            intents = intents.filter(booking__trip__trip_class=filters.trip_class)
        lines = lines.filter(
            journal_entry_id__in=list(intents.values_list("journal_entry_id", flat=True))
        )
    return lines


def money_by_currency(filters: AnalyticsFilters) -> list[dict[str, Any]]:
    """Revenue, gross and commission per currency.

    `revenue` is the business-clearing total — what the operator is
    actually owed, after Integra's commission. `gross` is what
    passengers paid. Both are reported rather than one, because
    "revenue" alone is ambiguous on a transport dashboard and an
    operator reading a gross figure as money they will receive is a
    real way to be misled.

    Gross is derived from the **debit side** of each entry rather than
    by reading the commission account: every payment entry balances to
    zero, its negative lines are exactly the money coming in (the PSP
    leg plus any wallet component), and its positive lines are the split
    of that money. So `gross = -(sum of negative lines)` and
    `commission = gross - revenue`, with no reference to an account this
    caller cannot see.
    """
    lines = _payment_lines(filters)
    clearing_ids = _clearing_account_ids(filters)

    gross_rows = (
        lines.filter(amount__lt=0).values("currency").annotate(total=Sum("amount")).order_by()
    )
    net_rows = (
        lines.filter(account_id__in=clearing_ids)
        .values("currency")
        .annotate(total=Sum("amount"))
        .order_by()
    )
    gross_by_currency = {row["currency"]: -_quantize(row["total"]) for row in gross_rows}
    net_by_currency = {row["currency"]: _quantize(row["total"]) for row in net_rows}

    volume_rows = (
        _succeeded_payments(filters).values("currency").annotate(count=Count("id")).order_by()
    )
    volume_by_currency = {row["currency"]: row["count"] for row in volume_rows}

    entries: list[dict[str, Any]] = []
    for currency in sorted(set(gross_by_currency) | set(net_by_currency) | set(volume_by_currency)):
        gross = gross_by_currency.get(currency, ZERO)
        revenue = net_by_currency.get(currency, ZERO)
        volume = volume_by_currency.get(currency, 0)
        entries.append(
            {
                "currency": currency,
                "revenue": _money(revenue),
                "gross": _money(gross),
                "commission": _money(gross - revenue),
                "transaction_volume": volume,
                # Gross, not net: this is what a passenger paid for a
                # ticket, which is the only reading of "ticket value"
                # that means anything to the person looking at it.
                "average_ticket_value": _money(gross / volume if volume else ZERO),
            }
        )
    return entries


def revenue_trend(filters: AnalyticsFilters) -> list[dict[str, Any]]:
    """Net revenue per bucket per currency, bucketed in the resolved
    timezone. Only buckets with data are emitted — see this module's
    docstring."""
    trunc = _TRUNC[filters.granularity]
    rows = (
        _payment_lines(filters)
        .filter(account_id__in=_clearing_account_ids(filters))
        .annotate(
            bucket=trunc("journal_entry__created_at", tzinfo=ZoneInfo(filters.timezone))
        )
        .values("bucket", "currency")
        .annotate(total=Sum("amount"))
        .order_by("bucket", "currency")
    )
    return [
        {
            "date": row["bucket"].astimezone(ZoneInfo(filters.timezone)).date(),
            "currency": row["currency"],
            "amount": _money(row["total"]),
        }
        for row in rows
        if row["bucket"] is not None
    ]


# --- the payments side ------------------------------------------------


def _succeeded_payments(
    filters: AnalyticsFilters, *, include_topups: bool = False
) -> QuerySet[PaymentIntent]:
    """Successful payments in the period.

    `include_topups` is the difference between the two questions this
    module answers about the same rows, and getting it backwards on
    either side would make a screen visibly fail to add up:

    - **Revenue** excludes wallet top-ups. Funding a balance is not
      revenue; it is money moving into a wallet, recognised when it is
      *spent*. Counting both double-counts every wallet-paid trip.
    - **The payments summary** includes them, because it sits above
      `GET /payments/`, which lists every `PaymentIntent` — a strip that
      silently omitted top-ups would not describe the table under it,
      which is the one property that endpoint exists to guarantee.
    """
    queryset = PaymentIntent.objects.filter(status=PaymentIntent.Status.SUCCEEDED)
    if not include_topups:
        queryset = queryset.filter(intent_type=PaymentIntent.IntentType.BOOKING_PAYMENT)
    return apply_to_payments(queryset, filters)


def payments_summary(filters: AnalyticsFilters) -> dict[str, Any]:
    """The metrics strip above the transactions table.

    Scoped on `PaymentIntent.created_at` through the shared
    `apply_to_payments`, exactly as `GET /payments/` is — that identity
    is the whole point of the shared filter module, and the parity test
    asserts it directly. It is why this figure can differ marginally
    from the revenue endpoint's at a period boundary: that one scopes on
    when the money moved, this one on when the payment was started, and
    each matches the rows its own screen shows.
    """
    scoped = apply_to_payments(PaymentIntent.objects.all(), filters)
    by_status = {
        row["status"]: row["count"]
        for row in scoped.values("status").annotate(count=Count("id")).order_by()
    }
    succeeded = scoped.filter(status=PaymentIntent.Status.SUCCEEDED)
    money_rows = (
        succeeded.values("currency")
        .annotate(total=Sum("amount"), wallet=Sum("wallet_component_amount"), count=Count("id"))
        .order_by()
    )
    return {
        "period": period_envelope(filters),
        "counts": {
            "total": scoped.count(),
            "succeeded": by_status.get(PaymentIntent.Status.SUCCEEDED, 0),
            "pending": by_status.get(PaymentIntent.Status.PENDING, 0),
            "failed": by_status.get(PaymentIntent.Status.FAILED, 0),
            "cancelled": by_status.get(PaymentIntent.Status.CANCELLED, 0),
            # Its own facet rather than a status: there is no refund
            # service, so nothing is netted off automatically and this
            # is a queue of things a human still has to reconcile.
            "requires_manual_refund": scoped.filter(requires_manual_refund=True).count(),
        },
        "money": [
            {
                "currency": row["currency"],
                # `amount` is the PSP leg and `wallet_component_amount`
                # the balance spent alongside it, so a blended payment
                # is only whole when both are added.
                "collected": _money((row["total"] or ZERO) + (row["wallet"] or ZERO)),
                "transaction_volume": row["count"],
            }
            for row in sorted(money_rows, key=lambda r: r["currency"])
        ],
        # Includes top-ups, matching `money` above and the table below —
        # so the channel slices always sum to what was collected.
        "channels": channel_breakdown(filters, include_topups=True),
    }


def channel_breakdown(
    filters: AnalyticsFilters, *, include_topups: bool = False
) -> list[dict[str, Any]]:
    """What passengers actually paid with, per currency.

    `include_topups` follows `_succeeded_payments`'s own split: the
    payments summary counts them (its total does), the revenue report
    does not (a top-up is not revenue). The invariant that falls out of
    getting this right is that the channel amounts always sum to the
    total they are rendered beside — asserted directly, because a
    breakdown that does not add up to its own headline is the most
    visible way for this screen to lose trust.

    Three things here are easy to get quietly wrong:

    - **Wallet is its own channel and is not in the `channel` column.**
      A booking paid entirely from a balance never reaches Paystack, so
      it has no PSP channel at all; `psp_provider == "wallet"` is what
      the wallet-payment path stamps and is the honest discriminator.
      A bare `GROUP BY channel` would report wallet spend as zero.
    - **A blended payment used two methods**, so it contributes its PSP
      leg to the PSP channel and its wallet component to `wallet`.
      Attributing the whole amount to either would misstate both.
    - **A blank channel is `unknown`, never guessed.** Every payment
      that predates spec 16 slice 1 has one, and inventing `card` for
      them would be inventing data.
    """
    totals: dict[tuple[str, str], Decimal] = defaultdict(lambda: ZERO)
    counts: dict[tuple[str, str], int] = defaultdict(int)
    for intent in _succeeded_payments(filters, include_topups=include_topups).only(
        "currency", "channel", "psp_provider", "amount", "wallet_component_amount"
    ):
        currency = intent.currency
        if intent.psp_provider == "wallet":
            totals[(currency, "wallet")] += intent.amount
            counts[(currency, "wallet")] += 1
            continue
        channel = intent.channel or "unknown"
        totals[(currency, channel)] += intent.amount
        counts[(currency, channel)] += 1
        if intent.wallet_component_amount > ZERO:
            totals[(currency, "wallet")] += intent.wallet_component_amount
            counts[(currency, "wallet")] += 1
    return [
        {
            "currency": currency,
            "channel": channel,
            "amount": _money(totals[(currency, channel)]),
            "transaction_volume": counts[(currency, channel)],
        }
        for currency, channel in sorted(totals)
    ]


# --- the operational side ---------------------------------------------


def period_envelope(filters: AnalyticsFilters) -> dict[str, Any]:
    """Echoed by every endpoint. This is what lets a screen tell "no
    revenue in this period" apart from "no data at all" — the same
    reason spec 10's availability endpoint returns an envelope rather
    than a bare array."""
    return {
        "from": filters.date_from,
        "to": filters.date_to,
        "timezone": filters.timezone,
        "granularity": filters.granularity,
    }


def booking_trend(filters: AnalyticsFilters) -> list[dict[str, Any]]:
    trunc = _TRUNC[filters.granularity]
    rows = (
        apply_to_bookings(Booking.objects.all(), filters)
        .annotate(bucket=trunc("created_at", tzinfo=ZoneInfo(filters.timezone)))
        .values("bucket")
        .annotate(count=Count("id"))
        .order_by("bucket")
    )
    return [
        {"date": row["bucket"].astimezone(ZoneInfo(filters.timezone)).date(), "count": row["count"]}
        for row in rows
        if row["bucket"] is not None
    ]


def _local_today(filters: AnalyticsFilters) -> date:
    return django_timezone.now().astimezone(ZoneInfo(filters.timezone)).date()


def dashboard(filters: AnalyticsFilters) -> dict[str, Any]:
    """The whole dashboard in one request.

    One envelope rather than a dozen endpoints the client would have to
    fan out to and reduce — which is exactly the "bounded fetch, then
    reduce locally" pattern CLAUDE.md records four production bugs from.
    """
    trips = apply_to_trips(Trip.objects.all(), filters)
    trip_counts = {
        row["status"]: row["count"]
        for row in trips.values("status").annotate(count=Count("id")).order_by()
    }
    bookings = apply_to_bookings(Booking.objects.all(), filters)
    booking_counts = {
        row["status"]: row["count"]
        for row in bookings.values("status").annotate(count=Count("id")).order_by()
    }

    routes = Route.objects.all()
    if filters.business is not None:
        routes = routes.filter(business=filters.business)

    incidents = apply_to_incidents(Incident.objects.all(), filters)

    return {
        "period": period_envelope(filters),
        # docs/specs/19-route-lifecycle.md replaced the old boolean with
        # a four-state status; this envelope keeps its pre-existing two
        # buckets rather than growing two more, since redesigning the
        # dashboard's route breakdown is a spec 16 concern, not spec
        # 19's. A draft or archived route counts in neither bucket, so
        # `active + inactive` is no longer every route for the business
        # — a real, accepted narrowing, not the exact same fact under a
        # new name.
        "routes": {
            "active": routes.filter(status=Route.Status.ACTIVE).count(),
            "inactive": routes.filter(status=Route.Status.INACTIVE).count(),
        },
        "trips": {
            "scheduled": trip_counts.get(Trip.Status.SCHEDULED, 0),
            "in_progress": trip_counts.get(Trip.Status.IN_PROGRESS, 0),
            "completed": trip_counts.get(Trip.Status.COMPLETED, 0),
            "cancelled": trip_counts.get(Trip.Status.CANCELLED, 0),
            # Deliberately outside the period: "how is today going" is a
            # different question from "how did this range go", and a
            # dashboard is asked both at once.
            "completed_today": Trip.objects.filter(
                service_date=_local_today(filters), status=Trip.Status.COMPLETED
            ).count(),
        },
        "bookings": {
            "total": bookings.count(),
            "paid": booking_counts.get(Booking.Status.PAID, 0),
            "cancelled": booking_counts.get(Booking.Status.CANCELLED, 0),
            "pending_payment": booking_counts.get(Booking.Status.PENDING_PAYMENT, 0),
        },
        # docs/specs/17-incidents.md. The key was shipped as a hardcoded
        # zero one spec early, precisely so filling it in here would be
        # additive rather than a breaking envelope change for a frontend
        # already reading this shape.
        #
        # "Open" is `apps.incidents.models.OPEN_STATUSES`, imported
        # rather than restated, so this stat and the queue's own
        # `open_only` filter cannot drift into disagreeing about what
        # the word means.
        "incidents": {"open": incidents.filter(status__in=OPEN_STATUSES).count()},
        "money": money_by_currency(filters),
        "trends": {"revenue": revenue_trend(filters), "bookings": booking_trend(filters)},
        "recent_incidents": [
            {
                "id": incident.id,
                "reference": incident.reference,
                "title": incident.title,
                "category": incident.category,
                "severity": incident.severity,
                "status": incident.status,
                "created_at": incident.created_at,
            }
            for incident in incidents.order_by("-created_at")[:RECENT_LIMIT]
        ],
        "recent_transactions": [
            {
                "id": intent.id,
                "business": intent.business_id,
                "amount": _money(intent.amount),
                "currency": intent.currency,
                "status": intent.status,
                "channel": "wallet" if intent.psp_provider == "wallet" else intent.channel,
                "created_at": intent.created_at,
            }
            for intent in apply_to_payments(PaymentIntent.objects.all(), filters).order_by(
                "-created_at"
            )[:RECENT_LIMIT]
        ],
    }


def revenue_report(filters: AnalyticsFilters) -> dict[str, Any]:
    """Totals, the trend series, and the three breakdowns the revenue
    screen shows. Every breakdown is keyed by currency for the same
    reason the totals are."""
    return {
        "period": period_envelope(filters),
        "money": money_by_currency(filters),
        "trend": revenue_trend(filters),
        "by_route": breakdown_by(filters, "booking__trip__route__name", "route"),
        "by_trip_class": breakdown_by(filters, "booking__trip__trip_class", "trip_class"),
        "by_channel": channel_breakdown(filters),
    }


def breakdown_by(filters: AnalyticsFilters, field: str, label: str) -> list[dict[str, Any]]:
    """Gross by one dimension of the trip a payment bought.

    Gross rather than net, because these breakdowns answer "where does
    the money come from" and a commission split applied uniformly adds
    nothing to that comparison. The totals block carries both.

    Rows with no value for the dimension are dropped rather than
    bucketed as "unknown": every one of them is a wallet top-up, which
    has no booking and therefore no trip, and which is not revenue at
    all.

    **Public because the `route-revenue` and `trip-class-revenue`
    exports are the same rows**, not a reshaping of them. A forwarding
    `route_revenue_rows()` would create two names for one thing, which
    is how a divergence starts. Note that `amount` here is **gross** —
    the exports rename the column `gross_amount` for exactly that
    reason, since the `revenue` export's own `revenue` column is net.
    """
    rows = (
        _succeeded_payments(filters)
        .exclude(**{f"{field}__isnull": True})
        .values(field, "currency")
        .annotate(
            amount=Sum("amount") + Sum("wallet_component_amount"), transaction_volume=Count("id")
        )
        .order_by()
    )
    return [
        {
            label: row[field],
            "currency": row["currency"],
            "amount": _money(row["amount"]),
            "transaction_volume": row["transaction_volume"],
        }
        for row in sorted(rows, key=lambda r: (str(r[field]), r["currency"]))
    ]


def trip_performance(*, trip: Trip) -> dict[str, Any]:
    """One trip's operational and financial outcome.

    Three `null`s here are load-bearing rather than incidental, and each
    is a case where zero would be a lie:

    - `occupancy_rate` when no vehicle is assigned — there is no
      denominator, and 0% would read as "nobody bought a seat" on a
      departure nobody has chosen a bus for.
    - `punctuality` before departure — a trip that has not left is not
      "0 minutes late".
    - `money.revenue_per_seat` with nothing sold.

    A cancelled trip is still reported, with both occupancy and
    punctuality suppressed: it is counted in the dashboard's totals but
    must not drag an occupancy or delay average.
    """
    sold, total = seats_sold_and_total(trip)
    cancelled = trip.status == Trip.Status.CANCELLED
    occupancy = None
    if total and not cancelled:
        occupancy = (Decimal(sold) / Decimal(total)).quantize(
            Decimal("0.001"), rounding=ROUND_HALF_UP
        )

    punctuality = None
    if trip.actual_departure_at is not None and not cancelled:
        delay = trip.actual_departure_at - trip.scheduled_departure_at
        delay_minutes = int(delay.total_seconds() // 60)
        punctuality = {
            "scheduled_departure_at": trip.scheduled_departure_at,
            "actual_departure_at": trip.actual_departure_at,
            "actual_arrival_at": trip.actual_arrival_at,
            "delay_minutes": delay_minutes,
            "on_time": delay_minutes <= 0,
        }

    return {
        "trip": {
            "id": trip.id,
            "route": trip.route.name,
            "trip_class": trip.trip_class,
            "status": trip.status,
            "booking_mode": trip.booking_mode,
            "service_date": trip.service_date,
        },
        "capacity": {
            "total_seats": total,
            "seats_sold": sold,
            "occupancy_rate": _rate(occupancy),
        },
        "punctuality": punctuality,
        "money": _trip_money(trip, sold),
        # Every incident filed against this trip, whatever its status —
        # a resolved fault still happened on this departure, and a
        # performance record that forgot it would be reporting the
        # trip's paperwork rather than its day.
        "incidents": Incident.objects.filter(trip=trip).count(),
        "cancelled": cancelled,
    }


def seats_sold_and_total(trip: Trip) -> tuple[int, int | None]:
    """Places sold, and the denominator to read them against.

    Public as of docs/specs/18-manifest-and-staff-booking.md slice 1,
    which needs exactly this pair for the manifest's `totals.capacity`
    — the same promotion spec 17 made of `_as_utc_range`. Re-deriving it
    there would mean a second copy of the open-seating-vs-`Seat`-count
    branch and of the "no vehicle means unknowable, not zero" rule, and
    the two would drift.

    Open seating has no `Seat` rows at all, so its denominator is the
    assigned vehicle's capacity — which is what
    `apps.ticketing.capacity.get_capacity` already computes, including
    the "no vehicle means unknowable, not unlimited" case that module
    owns. Reservation mode counts confirmed seat reservations against
    the vehicle type's seat count.
    """
    from apps.seating.models import Seat, SeatReservation

    vehicle = trip.vehicle
    if is_open_seating(trip):
        # The whole trip, not a segment: a per-trip figure asks how full
        # the bus was, and the first stop pair is where everyone boards.
        capacity = get_capacity(trip=trip, from_sequence=0, to_sequence=10_000)
        return capacity.sold, capacity.total

    sold = SeatReservation.objects.filter(
        trip=trip, status=SeatReservation.Status.CONFIRMED
    ).count()
    total = (
        Seat.objects.filter(vehicle_type=vehicle.vehicle_type).count()
        if vehicle is not None
        else None
    )
    return sold, total


def _trip_money(trip: Trip, sold: int) -> list[dict[str, Any]]:
    """Revenue for one trip, from the ledger.

    A `JournalEntry` carries no trip, so the chain runs
    Trip → `Booking` → `PaymentIntent.journal_entry` → clearing lines.
    That chain is complete rather than card-only: `pay_booking_from_wallet`
    also creates a `PaymentIntent` (already succeeded, no webhook), so
    every paid booking has one however it was paid.
    """
    entry_ids = list(
        PaymentIntent.objects.filter(
            booking__trip=trip,
            status=PaymentIntent.Status.SUCCEEDED,
            journal_entry__isnull=False,
        ).values_list("journal_entry_id", flat=True)
    )
    if not entry_ids:
        return []
    lines = JournalLine.objects.filter(journal_entry_id__in=entry_ids)
    clearing_ids = list(
        LedgerAccount.objects.filter(
            business=trip.business, account_type=LedgerAccount.AccountType.BUSINESS_CLEARING
        ).values_list("id", flat=True)
    )
    gross_rows = {
        row["currency"]: -_quantize(row["total"])
        for row in lines.filter(amount__lt=0)
        .values("currency")
        .annotate(total=Sum("amount"))
        .order_by()
    }
    net_rows = {
        row["currency"]: _quantize(row["total"])
        for row in lines.filter(account_id__in=clearing_ids)
        .values("currency")
        .annotate(total=Sum("amount"))
        .order_by()
    }
    return [
        {
            "currency": currency,
            "revenue": _money(net_rows.get(currency, ZERO)),
            "gross": _money(gross_rows.get(currency, ZERO)),
            "revenue_per_seat": (
                _money(net_rows.get(currency, ZERO) / sold) if sold else None
            ),
        }
        for currency in sorted(set(gross_rows) | set(net_rows))
    ]


# --- export rows ------------------------------------------------------
#
# One builder per export resource. They live here, not in `exports.py`,
# for the reason this module's docstring already gives: `services.py`
# says *what the numbers are* and owns every money and timezone
# decision, so a value has been through `_money()`/`_rate()`/
# `_local_iso()` before it is ever a cell. `exports.py` only turns rows
# into a file, and therefore needs no money knowledge at all.
#
# Every one of them returns a **materialised list**, and that is a load-
# bearing type rather than a stylistic one — see `exports.py`'s module
# docstring for what a lazy iterator would do here.


def _local_iso(value: datetime | None, tz_name: str) -> str | None:
    """A timestamp in the period's own timezone, ISO-8601 **with offset**.

    This whole spec buckets in the Business timezone, so a bare UTC
    timestamp sitting beside a Lagos-day bucket is the 23:30-crosses-
    midnight confusion the spec's own test plan names. The offset makes
    the value unambiguous to a machine reader; a spreadsheet will treat
    it as text rather than a date cell, which is the right trade.
    """
    return None if value is None else value.astimezone(ZoneInfo(tz_name)).isoformat()


def _channel_label(intent: PaymentIntent) -> str:
    """The same discriminator `channel_breakdown` uses, and for the same
    reason: a balance-funded payment has no PSP leg at all, and a blank
    column is "not captured", which must be reported rather than
    guessed. A raw blank is never emitted — in a spreadsheet it would
    read as missing data instead of as the documented `unknown`."""
    if intent.psp_provider == "wallet":
        return "wallet"
    return intent.channel or "unknown"


def _passenger_columns(user: Any) -> dict[str, Any]:
    """Who the row is about.

    Id, email and name together, deliberately: an operator's real reason
    for exporting is reconciliation or a manifest, and a bare UUID
    serves neither. The consequence is that these two files **are a
    customer list** once saved, which is why every export writes an
    `AuditLog` row and why the response carries `Cache-Control:
    no-store`.
    """
    full_name = f"{user.first_name} {user.last_name}".strip()
    return {
        "passenger_id": str(user.id),
        "passenger_email": user.email,
        "passenger_name": full_name,
    }


def manifest_rows(filters: AnalyticsFilters) -> list[dict[str, Any]]:
    """The trip manifest, as CSV rows —
    docs/specs/18-manifest-and-staff-booking.md slice 1.

    Its own resource rather than leaning on `bookings`, which the spec's
    non-goals assumed would cover it. It does, for a prepaid trip. A
    **pay-as-you-go** trip has no `Booking` rows at all, so a bookings
    export of one is an empty file — which is the worst possible answer
    to "print me the list of who is aboard".

    `filters.trip` is required, declared as `required_filters` on the
    `ExportSpec` and refused in `build_export` before this runs. Every
    other resource is bounded by a period; a manifest is bounded by a
    trip, and one with no trip named is not a smaller export but a
    different question.

    Deliberately **no passenger email**, unlike `bookings` and
    `transactions` — this mirrors the manifest screen, which the spec
    gates to name and seat because an operator matching a face to a seat
    needs no contact details. (That the bookings export does carry an
    email is a pre-existing inconsistency, not licence to repeat it.)

    Returns a **list**, not a generator: a lazily-produced body runs
    after `TenancyMiddleware` has reset its contextvars, and hands back a
    silently empty file with a 200.
    """
    from apps.booking.manifest import (
        PAY_AS_YOU_GO,
        journey_queryset,
        journey_row,
        manifest_kind,
        prepaid_rows,
    )

    trip = filters.trip
    # `build_export` has already refused a request with no trip; this is
    # the type narrowing, not the guard.
    assert trip is not None

    if manifest_kind(trip) == PAY_AS_YOU_GO:
        return [
            {
                "kind": PAY_AS_YOU_GO,
                "reference": "",
                "passenger_name": row["passenger_name"],
                "seat_number": "",
                "board_stop": row["board_stop"],
                # An open journey has neither, and blank is the honest
                # rendering in a spreadsheet — the passenger is still
                # aboard, and `status` says so.
                "alight_stop": row["alight_stop"] or "",
                "status": row["journey_status"],
                "booking_status": "",
                "currency": row["currency"],
                "fare": _money(row["fare"]) if row["fare"] is not None else "",
                "boarded_at": _local_iso(row["boarded_at"], filters.timezone),
            }
            for row in (journey_row(journey) for journey in journey_queryset(trip=trip))
        ]

    return [
        {
            "kind": "prepaid",
            "reference": row["booking_reference"],
            "passenger_name": row["passenger_name"],
            "seat_number": row["seat_number"] or "",
            "board_stop": "",
            "alight_stop": "",
            # Blank, not the word "None": a held seat that is not yet
            # paid for has no ticket, and `booking_status` beside it
            # says why.
            "status": row["ticket_status"] or "",
            "booking_status": row["booking_status"],
            "currency": row["currency"],
            "fare": _money(row["fare"]) if row["fare"] is not None else "",
            "boarded_at": (
                _local_iso(row["boarded_at"], filters.timezone) if row["boarded_at"] else ""
            ),
        }
        for row in prepaid_rows(trip=trip, include_cancelled=False)
    ]


def transaction_rows(filters: AnalyticsFilters) -> list[dict[str, Any]]:
    """One row per `PaymentIntent`, from the identical queryset
    `PaymentListCreateView.get_queryset()` builds — which is what makes
    "export current view" structural rather than aspirational."""
    queryset = apply_to_payment_records(
        PaymentIntent.objects.select_related(
            "business", "passenger", "booking__trip__route"
        ).all(),
        filters,
    ).order_by("-created_at")
    rows: list[dict[str, Any]] = []
    for intent in queryset:
        trip = intent.booking.trip if intent.booking is not None else None
        rows.append(
            {
                "created_at": _local_iso(intent.created_at, filters.timezone),
                "psp_reference": intent.psp_reference,
                "business": intent.business.name,
                "intent_type": intent.intent_type,
                "status": intent.status,
                "channel": _channel_label(intent),
                "currency": intent.currency,
                "amount": _money(intent.amount),
                "wallet_component_amount": _money(intent.wallet_component_amount),
                # Its own column, not left as an exercise. `amount` is
                # the Paystack leg only; slice 2's live reconciliation
                # *and* its first unit test both read it as the whole
                # payment and were wrong about every blended one. A
                # spreadsheet reader summing one column must not be able
                # to make that mistake.
                "total_paid": _money(intent.amount + intent.wallet_component_amount),
                "route": trip.route.name if trip else "",
                "trip_class": trip.trip_class if trip else "",
                "service_date": trip.service_date if trip else None,
                "requires_manual_refund": intent.requires_manual_refund,
                **_passenger_columns(intent.passenger),
            }
        )
    return rows


def booking_rows(filters: AnalyticsFilters) -> list[dict[str, Any]]:
    """One row per `Booking`, from the queryset `GET /bookings/` now
    shares with this module."""
    queryset = apply_to_booking_records(
        Booking.objects.select_related(
            "business", "passenger", "trip__route", "from_stop", "to_stop"
        ).all(),
        filters,
    ).order_by("-created_at")
    rows: list[dict[str, Any]] = []
    for booking in queryset:
        rows.append(
            {
                "created_at": _local_iso(booking.created_at, filters.timezone),
                "booking_id": str(booking.id),
                "business": booking.business.name,
                "status": booking.status,
                "trip_id": str(booking.trip_id),
                "service_date": booking.trip.service_date,
                "scheduled_departure_at": _local_iso(
                    booking.trip.scheduled_departure_at, filters.timezone
                ),
                "route": booking.trip.route.name,
                "trip_class": booking.trip.trip_class,
                # Blank on a reservation booking, where the stop pair
                # lives per `SeatReservation` rather than on the Booking.
                "from_stop": booking.from_stop.name if booking.from_stop else "",
                "to_stop": booking.to_stop.name if booking.to_stop else "",
                "passenger_count": booking.passenger_count,
                "currency": booking.currency,
                "total_amount": _money(booking.total_amount),
                **_passenger_columns(booking.passenger),
            }
        )
    return rows


def trip_performance_rows(filters: AnalyticsFilters) -> list[dict[str, Any]]:
    """The set-wise twin of `trip_performance`, for the export.

    **Six queries regardless of how many trips are in range.**
    `trip_performance` is five to seven queries *per trip*; at
    `EXPORT_MAX_ROWS` that would be several hundred thousand.

    It must agree with `trip_performance` field for field. A divergence
    between a screen and the file it exports is precisely the failure
    the shared filter module exists to make impossible, so there is a
    parity test per shape — reservation with and without a vehicle, open
    seating enforced and unenforced, cancelled, departed, not yet
    departed.

    `apps.ticketing.capacity` is reused for its **semantics**
    (`is_open_seating`, `OCCUPYING_STATUSES`), not its queries:
    `get_capacity` issues one `COUNT` per trip and cannot be called in a
    loop here. Its whole-trip window `[0, 10_000)` overlaps every real
    `segment_range`, so at trip grain the overlap predicate is a no-op
    and the set-wise count is `status__in=OCCUPYING_STATUSES` alone —
    asserted against `get_capacity` directly by
    `test_exports.py::test_open_seating_sold_matches_get_capacity`
    rather than left as a claim in a comment. That module's ADR-0008
    obligation is about the *write* path (`issue_place` and its lock);
    `get_capacity` documents itself as read-only and lock-free, so a
    set-wise read that provably agrees with it is legitimate.

    One row per `(trip, currency)`. A trip with no payments still gets
    exactly one row, in its Business's own currency, with `"0.00"` — a
    trip that carried nobody is a fact worth exporting, not an absence.
    """
    trip_queryset = apply_to_trips(Trip.objects.all(), filters)
    # Every joined table here is a client-owned BaseModel (VehicleType
    # carries its own `business` FK), so no join can hit the
    # invisible-row trap `LedgerAccount` causes elsewhere.
    trips = list(
        trip_queryset.select_related(
            "route", "business", "vehicle__vehicle_type"
        ).order_by("service_date", "scheduled_departure_at")
    )
    if not trips:
        return []

    reserved_by_trip = {
        row["trip_id"]: row["n"]
        for row in SeatReservation.objects.filter(
            trip__in=trip_queryset, status=SeatReservation.Status.CONFIRMED
        )
        .values("trip_id")
        .annotate(n=Count("id"))
        .order_by()
    }
    boarded_by_trip = {
        row["trip_id"]: row["n"]
        for row in Ticket.objects.filter(
            trip__in=trip_queryset, status__in=OCCUPYING_STATUSES
        )
        .values("trip_id")
        .annotate(n=Count("id"))
        .order_by()
    }
    # A small id set — vehicle types per Business — so a literal `__in`
    # is fine here where it would not be for the trips themselves.
    vehicle_type_ids = {
        trip.vehicle.vehicle_type_id for trip in trips if trip.vehicle is not None
    }
    seats_by_vehicle_type = {
        row["vehicle_type_id"]: row["n"]
        for row in Seat.objects.filter(vehicle_type_id__in=vehicle_type_ids)
        .values("vehicle_type_id")
        .annotate(n=Count("id"))
        .order_by()
    }

    entry_to_trip = dict(
        PaymentIntent.objects.filter(
            booking__trip__in=trip_queryset,
            status=PaymentIntent.Status.SUCCEEDED,
            journal_entry__isnull=False,
        ).values_list("journal_entry_id", "booking__trip_id")
    )
    clearing_ids = _clearing_account_ids_for({trip.business_id for trip in trips})
    # Conditional aggregation collapses `_trip_money`'s two queries into
    # one, and the account ids are still resolved separately and
    # filtered on **as values** — rule 2 of this module's docstring,
    # unchanged. Gross comes off the debit side, so the commission
    # account is never read.
    money: dict[Any, dict[str, dict[str, Decimal]]] = defaultdict(
        lambda: defaultdict(lambda: {"gross": ZERO, "net": ZERO})
    )
    for row in (
        JournalLine.objects.filter(journal_entry_id__in=list(entry_to_trip))
        .values("journal_entry_id", "currency")
        .annotate(
            gross=Sum("amount", filter=Q(amount__lt=0)),
            net=Sum("amount", filter=Q(account_id__in=clearing_ids)),
        )
        .order_by()
    ):
        trip_id = entry_to_trip[row["journal_entry_id"]]
        bucket = money[trip_id][row["currency"]]
        bucket["gross"] += -(row["gross"] or ZERO)
        bucket["net"] += row["net"] or ZERO

    rows: list[dict[str, Any]] = []
    for trip in trips:
        cancelled = trip.status == Trip.Status.CANCELLED
        sold, total = _set_wise_sold_and_total(
            trip, reserved_by_trip, boarded_by_trip, seats_by_vehicle_type
        )
        occupancy = None
        if total and not cancelled:
            occupancy = (Decimal(sold) / Decimal(total)).quantize(
                Decimal("0.001"), rounding=ROUND_HALF_UP
            )

        # All four blank together, in lockstep with the endpoint's
        # `punctuality: null`.
        delay_minutes: int | None = None
        on_time: bool | None = None
        actual_departure_at: str | None = None
        actual_arrival_at: str | None = None
        if trip.actual_departure_at is not None and not cancelled:
            delay_minutes = int(
                (trip.actual_departure_at - trip.scheduled_departure_at).total_seconds() // 60
            )
            on_time = delay_minutes <= 0
            actual_departure_at = _local_iso(trip.actual_departure_at, filters.timezone)
            actual_arrival_at = _local_iso(trip.actual_arrival_at, filters.timezone)

        by_currency = money.get(trip.id, {})
        currencies = sorted({trip.business.currency} | set(by_currency))
        for currency in currencies:
            totals = by_currency.get(currency, {"gross": ZERO, "net": ZERO})
            rows.append(
                {
                    "service_date": trip.service_date,
                    "trip_id": str(trip.id),
                    "route": trip.route.name,
                    "trip_class": trip.trip_class,
                    "booking_mode": trip.booking_mode,
                    "status": trip.status,
                    "cancelled": cancelled,
                    # Trip-grain, always populated — unlike the JSON
                    # endpoint, where it lives inside the punctuality
                    # block and so vanishes for a cancelled or
                    # not-yet-departed trip. A file in which no future
                    # departure has a scheduled time is materially less
                    # useful, and the scheduled time is a fact about the
                    # trip rather than about its punctuality.
                    "scheduled_departure_at": _local_iso(
                        trip.scheduled_departure_at, filters.timezone
                    ),
                    "actual_departure_at": actual_departure_at,
                    "actual_arrival_at": actual_arrival_at,
                    "delay_minutes": delay_minutes,
                    "on_time": on_time,
                    "total_seats": total,
                    "seats_sold": sold,
                    "occupancy_rate": _rate(occupancy),
                    "currency": currency,
                    "revenue": _money(totals["net"]),
                    "gross": _money(totals["gross"]),
                    "revenue_per_seat": (
                        _money(totals["net"] / sold) if sold else None
                    ),
                }
            )
    return rows


def _set_wise_sold_and_total(
    trip: Trip,
    reserved_by_trip: dict[Any, int],
    boarded_by_trip: dict[Any, int],
    seats_by_vehicle_type: dict[Any, int],
) -> tuple[int, int | None]:
    """`seats_sold_and_total`'s branch structure, reading pre-fetched
    counts instead of issuing its own queries.

    `total` is `None` — unknowable, never `0` — with no vehicle, and for
    open seating with capacity unenforced. That is `get_capacity`'s own
    rule, reproduced from data already on the `select_related` row.
    """
    if is_open_seating(trip):
        sold = boarded_by_trip.get(trip.id, 0)
        if not trip.business.capacity_enforced or trip.vehicle is None:
            return sold, None
        return sold, trip.vehicle.vehicle_type.capacity

    sold = reserved_by_trip.get(trip.id, 0)
    if trip.vehicle is None:
        return sold, None
    return sold, seats_by_vehicle_type.get(trip.vehicle.vehicle_type_id, 0)
