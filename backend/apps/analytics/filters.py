"""The one filter set every analytics surface shares — see
docs/specs/16-operational-analytics.md.

**This module exists so a metric and the table under it cannot
disagree.** The spec's Failure modes section names that as a structural
risk rather than a discipline problem: if the dashboard, the summary
strip and `GET /payments/` each hand-wrote their own `.filter()` chain,
a divergence would be three bugs to find instead of one. Every caller
resolves a request into one `AnalyticsFilters` and then applies it
through the `apply_*` functions below.

Nothing here uses `platform_staff_bypass()`, deliberately. Aggregates
run under the caller's ordinary tenancy context — an aggregate that
bypassed RLS would be the worst possible place to leak another Client's
numbers.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from django.db.models import Q, QuerySet
from django.utils import timezone as django_timezone
from rest_framework import serializers

from apps.booking.models import Booking
from apps.businesses.models import Business
from apps.incidents.models import Incident
from apps.network.models import Route
from apps.payments.models import PaymentIntent
from apps.scheduling.models import Trip

UTC = ZoneInfo("UTC")

#: How many days each bucket size may span. A caller asking for more is
#: told which coarser granularity would answer the same question, rather
#: than being handed 730 points nobody can read (this spec's own edge
#: case table).
GRANULARITY_MAX_DAYS = {"day": 92, "week": 366, "month": 1827}

#: The next size up, for that error message. `month` has no successor —
#: five years of monthly buckets is where this reporting stops.
_COARSER = {"day": "week", "week": "month"}

#: The window a caller who names no period gets. Rolling rather than
#: calendar-aligned: a dashboard loaded on the 1st of the month must
#: still show a month of trend, not one point.
DEFAULT_PERIOD_DAYS = 30


class MissingExportFilter(Exception):
    """A resource needs a filter the caller did not name.

    Only `manifest` needs one so far: every other export is bounded by a
    period, and a manifest is bounded by a trip. An export with no trip
    is not a bigger export, it is a different question — so it is
    refused rather than answered with every ticket the Client has ever
    issued.

    Lives here rather than in `exports.py` because that module imports
    `services`, which is what raises this — the other direction would be
    a cycle. It is a filter concern either way.
    """


@dataclass(frozen=True)
class AnalyticsFilters:
    """A validated, resolved filter set.

    `date_from`/`date_to` are inclusive **local** dates in `timezone`;
    `range_start`/`range_end` are the half-open UTC instants they
    correspond to, which is what every `created_at` comparison actually
    uses. Keeping both is deliberate — the dates are what the envelope
    echoes back to the caller, and the instants are what the database
    sees.
    """

    business: Business | None
    route: Route | None
    #: docs/specs/18-manifest-and-staff-booking.md slice 1. Only the
    #: `manifest` export reads it — it is not an aggregation dimension,
    #: and no `apply_to_*` narrows on it. It lives here rather than in a
    #: parallel filter set because `GET /exports/{resource}/` hands every
    #: resource one `AnalyticsFilters`, and a second shape would mean a
    #: second parsing path for the same query string.
    trip: Trip | None
    trip_class: str
    #: A `PaymentIntent` status. Named for its model rather than
    #: generically, because one `status` field validated against two
    #: enums is exactly how `GET /bookings/?status=paid` became a 400 —
    #: see `booking_status` below.
    status: str
    booking_status: str
    channel: str
    granularity: str
    timezone: str
    date_from: date
    date_to: date
    range_start: datetime
    range_end: datetime
    #: Whether the caller actually named a period, as opposed to being
    #: given the rolling default. Aggregates ignore this — a dashboard
    #: with no period is meaningless, so they are always bounded. Record
    #: lists read it, because they must not be: see
    #: `apply_to_payment_records`.
    period_explicit: bool


def resolve_timezone(*, business: Business | None) -> str:
    """The timezone day buckets are cut in.

    One named Business uses its own. Without one, the Client's
    Businesses are consulted: a single distinct timezone is used, and
    **two or more fall back to UTC** — there is no correct local day for
    a Client operating in Lagos and Gaborone at once, and silently
    picking one of them would put revenue in the wrong day for the
    other. The envelope reports whichever was used, so the caller is
    never left guessing (this spec's own edge case table).
    """
    if business is not None:
        return business.timezone
    zones = set(Business.objects.values_list("timezone", flat=True))
    if len(zones) == 1:
        return zones.pop()
    return "UTC"


def as_utc_range(*, date_from: date, date_to: date, tz_name: str) -> tuple[datetime, datetime]:
    """The half-open UTC instant range covering `[date_from, date_to]`
    read as local days. `date_to` is inclusive, so the end is the start
    of the following local day.

    Public since docs/specs/17-incidents.md: `apps.incidents` needs the
    same local-day window for its own queue filter, and a second
    implementation of "which instants belong to a Lagos day" is exactly
    the kind of duplication that drifts by an hour and is never noticed.
    """
    tz = ZoneInfo(tz_name)
    start = datetime.combine(date_from, time.min, tzinfo=tz).astimezone(UTC)
    end = datetime.combine(date_to + timedelta(days=1), time.min, tzinfo=tz).astimezone(UTC)
    return start, end


class AnalyticsFilterSerializer(serializers.Serializer):
    """Query shape for every analytics endpoint, and for `GET /payments/`.

    FKs are resolved in `validate_<field>()` rather than through
    `PrimaryKeyRelatedField(queryset=...)`: declared-field querysets are
    evaluated once at class-body execution time, before any request has
    set a tenancy context, and freeze to an empty queryset forever —
    the `SerializerMetaclass` trap CLAUDE.md records. Resolving through
    `Business.objects`/`Route.objects` here also means another Client's
    id is a 400 rather than a silently empty aggregate.
    """

    business = serializers.UUIDField(required=False)
    route = serializers.UUIDField(required=False)
    trip = serializers.UUIDField(required=False)
    trip_class = serializers.ChoiceField(choices=Business.TripClass.choices, required=False)
    date_from = serializers.DateField(required=False)
    date_to = serializers.DateField(required=False)
    # Two status dimensions, named for their models, because they are
    # validated against different enums. Collapsing them into one shared
    # `status` was a real defect: `GET /bookings/?status=paid` — a
    # perfectly valid filter on that list — would have 400'd against
    # PaymentIntent's choices the moment the bookings list adopted this
    # module. A field that means two things cannot validate either.
    status = serializers.ChoiceField(choices=PaymentIntent.Status.choices, required=False)
    booking_status = serializers.ChoiceField(choices=Booking.Status.choices, required=False)
    # Free text, matching the column: this is a value Paystack controls
    # and a choice list would 400 on a method they added last week.
    channel = serializers.CharField(required=False, allow_blank=True, max_length=32)
    granularity = serializers.ChoiceField(
        choices=[(key, key) for key in GRANULARITY_MAX_DAYS], required=False
    )

    def validate_business(self, value: Any) -> Business:
        try:
            return Business.objects.get(pk=value)
        except Business.DoesNotExist:
            raise serializers.ValidationError(
                "Unknown business.", code="unknown_business"
            ) from None

    def validate_route(self, value: Any) -> Route:
        try:
            return Route.objects.get(pk=value)
        except Route.DoesNotExist:
            raise serializers.ValidationError("Unknown route.", code="unknown_route") from None

    def validate_trip(self, value: Any) -> Trip:
        # Through the tenant-scoped manager, so another Client's trip is
        # an "Unknown trip." 400 rather than a silently empty export.
        try:
            return Trip.objects.select_related("route", "business", "vehicle", "driver").get(
                pk=value
            )
        except Trip.DoesNotExist:
            raise serializers.ValidationError("Unknown trip.", code="unknown_trip") from None

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        business = attrs.get("business")
        route = attrs.get("route")
        if business is not None and route is not None and route.business_id != business.id:
            raise serializers.ValidationError(
                {"route": "That route does not belong to the selected business."},
                code="route_business_mismatch",
            )

        tz_name = resolve_timezone(business=business)
        today = django_timezone.now().astimezone(ZoneInfo(tz_name)).date()
        date_to = attrs.get("date_to") or today
        date_from = attrs.get("date_from") or date_to - timedelta(days=DEFAULT_PERIOD_DAYS - 1)

        if date_from > date_to:
            raise serializers.ValidationError(
                {"date_from": "date_from must not be after date_to."}, code="invalid_period"
            )

        granularity = attrs.get("granularity") or "day"
        span_days = (date_to - date_from).days + 1
        cap = GRANULARITY_MAX_DAYS[granularity]
        if span_days > cap:
            coarser = _COARSER.get(granularity)
            hint = (
                f" Use granularity={coarser} for a longer range."
                if coarser
                else " Narrow the range."
            )
            raise serializers.ValidationError(
                {
                    "granularity": (
                        f"A {granularity} trend covers at most {cap} days; "
                        f"this range is {span_days}.{hint}"
                    )
                },
                code="range_too_long",
            )

        range_start, range_end = as_utc_range(
            date_from=date_from, date_to=date_to, tz_name=tz_name
        )
        attrs["resolved"] = AnalyticsFilters(
            business=business,
            route=route,
            trip=attrs.get("trip"),
            trip_class=attrs.get("trip_class", ""),
            status=attrs.get("status", ""),
            booking_status=attrs.get("booking_status", ""),
            channel=attrs.get("channel", "").strip(),
            granularity=granularity,
            timezone=tz_name,
            date_from=date_from,
            date_to=date_to,
            range_start=range_start,
            range_end=range_end,
            period_explicit=bool(attrs.get("date_from") or attrs.get("date_to")),
        )
        return attrs


def resolve_filters(query_params: Any) -> AnalyticsFilters:
    """Validate a request's query params into one `AnalyticsFilters`,
    raising DRF's own 400 on anything invalid."""
    serializer = AnalyticsFilterSerializer(data=_as_plain_dict(query_params))
    serializer.is_valid(raise_exception=True)
    resolved: AnalyticsFilters = serializer.validated_data["resolved"]
    return resolved


def _as_plain_dict(query_params: Any) -> dict[str, Any]:
    """A `QueryDict` hands `serializers.Serializer` its *last* value per
    key, which is fine, but `.dict()` also flattens it into something
    predictable to test against. Mirrors
    `apps.network.views._as_plain_dict`'s own reason for existing."""
    return query_params.dict() if hasattr(query_params, "dict") else dict(query_params)


# --- applying the filters --------------------------------------------
# One function per model rather than one clever generic one: the models
# reach `business`/`route`/`trip_class` by different paths, and spelling
# each out is what makes a wrong join visible in review.


def apply_to_payments(
    queryset: QuerySet[PaymentIntent], filters: AnalyticsFilters, *, window: bool = True
) -> QuerySet[PaymentIntent]:
    """`PaymentIntent` has no route or trip class of its own, so those
    two reach it through the booking's trip. A wallet top-up has no
    booking at all and therefore drops out of any route- or
    class-filtered view — correct, since a top-up is not travel.

    `window=False` skips the date range entirely. Only record-grain
    callers pass it, through `apply_to_payment_records` — see there.
    """
    if window:
        queryset = queryset.filter(
            created_at__gte=filters.range_start, created_at__lt=filters.range_end
        )
    if filters.business is not None:
        queryset = queryset.filter(business=filters.business)
    if filters.route is not None:
        queryset = queryset.filter(booking__trip__route=filters.route)
    if filters.trip_class:
        queryset = queryset.filter(booking__trip__trip_class=filters.trip_class)
    if filters.status:
        queryset = queryset.filter(status=filters.status)
    if filters.channel:
        queryset = queryset.filter(_channel_filter(filters.channel))
    return queryset


def _channel_filter(channel: str) -> Q:
    """`wallet` is not a Paystack channel and is never in the column —
    it is what `psp_provider` says about a booking paid from a wallet
    balance, which has no PSP leg at all. `unknown` is the absence of a
    captured channel, which the spec requires be reported rather than
    guessed at."""
    if channel == "wallet":
        return Q(psp_provider="wallet")
    if channel == "unknown":
        return Q(channel="") & ~Q(psp_provider="wallet")
    return Q(channel=channel) & ~Q(psp_provider="wallet")


def apply_to_bookings(
    queryset: QuerySet[Booking], filters: AnalyticsFilters, *, window: bool = True
) -> QuerySet[Booking]:
    """Narrows `booking_status`, never `status` — see the serializer.

    `GET /bookings/` routes its own `?status=` through `booking_status`,
    so the staff list and the bookings export select the same rows for
    the same query string. That parity is the point of this module.
    """
    if window:
        queryset = queryset.filter(
            created_at__gte=filters.range_start, created_at__lt=filters.range_end
        )
    if filters.business is not None:
        queryset = queryset.filter(business=filters.business)
    if filters.route is not None:
        queryset = queryset.filter(trip__route=filters.route)
    if filters.trip_class:
        queryset = queryset.filter(trip__trip_class=filters.trip_class)
    if filters.booking_status:
        queryset = queryset.filter(status=filters.booking_status)
    return queryset


def apply_to_incidents(
    queryset: QuerySet[Incident], filters: AnalyticsFilters
) -> QuerySet[Incident]:
    """The dashboard's open-incident count and recent list, narrowed the
    same way every other aggregate on that screen is.

    Filtered on `created_at` rather than the incident's own trip's
    service date: an incident belongs to when it was *reported*, and a
    fault reported today about last month's trip is this month's
    problem. Deliberately narrower than
    `apps.incidents.serializers.IncidentListQuerySerializer`, which is a
    record list with its own dimensions (severity, category, source) —
    those are not aggregate dimensions and do not belong here.
    """
    queryset = queryset.filter(
        created_at__gte=filters.range_start, created_at__lt=filters.range_end
    )
    if filters.business is not None:
        queryset = queryset.filter(business=filters.business)
    if filters.route is not None:
        queryset = queryset.filter(route=filters.route)
    return queryset


def apply_to_trips(queryset: QuerySet[Trip], filters: AnalyticsFilters) -> QuerySet[Trip]:
    """Filtered on `service_date`, not `created_at`: a Trip is generated
    days or weeks before it runs, and an operator asking about "last
    week" means the week it was travelled, not the week it was
    scheduled."""
    queryset = queryset.filter(
        service_date__gte=filters.date_from, service_date__lte=filters.date_to
    )
    if filters.business is not None:
        queryset = queryset.filter(business=filters.business)
    if filters.route is not None:
        queryset = queryset.filter(route=filters.route)
    if filters.trip_class:
        queryset = queryset.filter(trip_class=filters.trip_class)
    return queryset


# --- record lists, and the exports that mirror them -------------------
#
# **A record list must not be silently truncated to the default period,
# and an aggregate must not be unbounded.** These two wrappers are where
# that distinction lives, so that a list endpoint and the export of the
# same rows can never disagree about it: both call the same function.
#
# This was a real, shipped bug. Slice 2 pointed `GET /payments/` at
# `apply_to_payments` directly, which meant the payments list — a
# support and dispute screen — silently showed only the last 30 days
# from that moment on. A payment from two months ago simply was not
# there, with no filter chip, no empty-state message and no error. It
# went unnoticed because every fixture and every row in the dev database
# was recent. Found while migrating `GET /bookings/` onto this module in
# slice 4, which would have inherited exactly the same defect.
#
# An aggregate is different and keeps its default: "revenue, all time"
# is not a question a dashboard is asking, and an unbounded trend has no
# meaningful axis. A paginated record list is already bounded by its own
# pagination.


def apply_to_payment_records(
    queryset: QuerySet[PaymentIntent], filters: AnalyticsFilters
) -> QuerySet[PaymentIntent]:
    """`GET /payments/` and `GET /exports/transactions/` both call this,
    which is what makes "export current view" true of them."""
    return apply_to_payments(queryset, filters, window=filters.period_explicit)


def apply_to_booking_records(
    queryset: QuerySet[Booking], filters: AnalyticsFilters
) -> QuerySet[Booking]:
    """`GET /bookings/` and `GET /exports/bookings/` both call this."""
    return apply_to_bookings(queryset, filters, window=filters.period_explicit)
