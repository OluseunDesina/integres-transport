"""Schema-only response shapes for apps.analytics — see
docs/specs/16-operational-analytics.md.

None of these is backed by a model and none is used to parse input;
they exist so `drf-spectacular` emits a real type for each envelope
instead of a bare object, and so the frontend's generated `schema.ts`
knows what it is reading. Same convention
`apps.ticketing.serializers.SigningKeysResponseSerializer` and
`apps.tapngo.serializers.FareJourneyTripSerializer` already established
for plain-dict responses.
"""

from rest_framework import serializers


class PeriodSerializer(serializers.Serializer):
    """Echoed by every endpoint. Without it a screen cannot tell "no
    revenue in this period" from "no data at all" — the distinction
    spec 10's availability envelope exists for, applied here."""

    to = serializers.DateField()
    timezone = serializers.CharField()
    granularity = serializers.CharField()

    def get_fields(self) -> dict[str, serializers.Field]:
        # `from` is a Python keyword, so it cannot be written as a class
        # attribute — but it is the right key in the payload, and
        # `get_fields()` is the sanctioned place to add one that cannot
        # be declared. drf-spectacular reads the result, so the
        # generated schema carries it too.
        fields = super().get_fields()
        fields["from"] = serializers.DateField()
        return fields


class MoneyEntrySerializer(serializers.Serializer):
    """One currency's totals. **Always a list, never a scalar** — a
    Client can run an NGN and a BWP Business at once, and adding those
    two numbers produces a figure that is not money."""

    currency = serializers.CharField()
    # What the operator is owed, after commission — the ledger figure.
    revenue = serializers.DecimalField(max_digits=14, decimal_places=2)
    # What passengers paid. Reported beside `revenue` so neither has to
    # be inferred and neither can be misread as the other.
    gross = serializers.DecimalField(max_digits=14, decimal_places=2)
    commission = serializers.DecimalField(max_digits=14, decimal_places=2)
    transaction_volume = serializers.IntegerField()
    average_ticket_value = serializers.DecimalField(max_digits=14, decimal_places=2)


class RevenueTrendPointSerializer(serializers.Serializer):
    """Only buckets with data appear. A zero-revenue day and a day
    before the Business existed must not render identically, so the
    client draws gaps rather than zeros."""

    date = serializers.DateField()
    currency = serializers.CharField()
    amount = serializers.DecimalField(max_digits=14, decimal_places=2)


class BookingTrendPointSerializer(serializers.Serializer):
    date = serializers.DateField()
    count = serializers.IntegerField()


class ChannelBreakdownSerializer(serializers.Serializer):
    """`channel` is `wallet` for balance-funded payments (which have no
    PSP leg at all) and `unknown` for anything with no captured channel
    — never guessed."""

    currency = serializers.CharField()
    channel = serializers.CharField()
    amount = serializers.DecimalField(max_digits=14, decimal_places=2)
    transaction_volume = serializers.IntegerField()


class RecentTransactionSerializer(serializers.Serializer):
    id = serializers.UUIDField()
    business = serializers.UUIDField()
    amount = serializers.DecimalField(max_digits=14, decimal_places=2)
    currency = serializers.CharField()
    status = serializers.CharField()
    channel = serializers.CharField()
    created_at = serializers.DateTimeField()


class RouteCountsSerializer(serializers.Serializer):
    active = serializers.IntegerField()
    inactive = serializers.IntegerField()


class TripCountsSerializer(serializers.Serializer):
    scheduled = serializers.IntegerField()
    in_progress = serializers.IntegerField()
    completed = serializers.IntegerField()
    cancelled = serializers.IntegerField()
    #: Deliberately outside the selected period — "how is today going"
    #: is a different question from "how did this range go".
    completed_today = serializers.IntegerField()


class BookingCountsSerializer(serializers.Serializer):
    total = serializers.IntegerField()
    paid = serializers.IntegerField()
    cancelled = serializers.IntegerField()
    pending_payment = serializers.IntegerField()


class IncidentCountsSerializer(serializers.Serializer):
    """Real since docs/specs/17-incidents.md. Shipped one spec early as a
    hardcoded zero precisely so filling it in was additive rather than a
    breaking envelope change for a frontend already reading this shape.

    `open` is `apps.incidents.models.OPEN_STATUSES` — open, acknowledged
    or investigating — not the literal `open` status alone.
    """

    open = serializers.IntegerField()


class RecentIncidentSerializer(serializers.Serializer):
    """Was `ListField(child=DictField())` while the list was always
    empty, which generated as an untyped record in `schema.ts`. Declared
    properly now that it carries rows the operator UI has to render."""

    id = serializers.UUIDField()
    reference = serializers.CharField()
    title = serializers.CharField()
    category = serializers.CharField()
    severity = serializers.CharField()
    status = serializers.CharField()
    created_at = serializers.DateTimeField()


class DashboardTrendsSerializer(serializers.Serializer):
    revenue = RevenueTrendPointSerializer(many=True)
    bookings = BookingTrendPointSerializer(many=True)


class DashboardSerializer(serializers.Serializer):
    period = PeriodSerializer()
    routes = RouteCountsSerializer()
    trips = TripCountsSerializer()
    bookings = BookingCountsSerializer()
    incidents = IncidentCountsSerializer()
    money = MoneyEntrySerializer(many=True)
    trends = DashboardTrendsSerializer()
    recent_incidents = RecentIncidentSerializer(many=True)
    recent_transactions = RecentTransactionSerializer(many=True)


class RouteRevenueSerializer(serializers.Serializer):
    route = serializers.CharField()
    currency = serializers.CharField()
    amount = serializers.DecimalField(max_digits=14, decimal_places=2)
    transaction_volume = serializers.IntegerField()


class TripClassRevenueSerializer(serializers.Serializer):
    trip_class = serializers.CharField()
    currency = serializers.CharField()
    amount = serializers.DecimalField(max_digits=14, decimal_places=2)
    transaction_volume = serializers.IntegerField()


class RevenueReportSerializer(serializers.Serializer):
    period = PeriodSerializer()
    money = MoneyEntrySerializer(many=True)
    trend = RevenueTrendPointSerializer(many=True)
    by_route = RouteRevenueSerializer(many=True)
    by_trip_class = TripClassRevenueSerializer(many=True)
    by_channel = ChannelBreakdownSerializer(many=True)


class PaymentSummaryCountsSerializer(serializers.Serializer):
    total = serializers.IntegerField()
    succeeded = serializers.IntegerField()
    pending = serializers.IntegerField()
    failed = serializers.IntegerField()
    cancelled = serializers.IntegerField()
    #: Its own facet, not a status: there is no refund service, so
    #: nothing is netted off automatically and this is a queue of things
    #: a human still has to reconcile.
    requires_manual_refund = serializers.IntegerField()


class PaymentSummaryMoneySerializer(serializers.Serializer):
    currency = serializers.CharField()
    #: PSP leg plus wallet component — a blended payment is only whole
    #: when both are added.
    collected = serializers.DecimalField(max_digits=14, decimal_places=2)
    transaction_volume = serializers.IntegerField()


class PaymentSummarySerializer(serializers.Serializer):
    period = PeriodSerializer()
    counts = PaymentSummaryCountsSerializer()
    money = PaymentSummaryMoneySerializer(many=True)
    channels = ChannelBreakdownSerializer(many=True)


class TripPerformanceTripSerializer(serializers.Serializer):
    id = serializers.UUIDField()
    route = serializers.CharField()
    trip_class = serializers.CharField()
    status = serializers.CharField()
    booking_mode = serializers.CharField()
    service_date = serializers.DateField()


class TripCapacitySerializer(serializers.Serializer):
    #: Null when no vehicle is assigned — unknowable, not unlimited.
    total_seats = serializers.IntegerField(allow_null=True)
    seats_sold = serializers.IntegerField()
    #: Null rather than 0 with no denominator, and suppressed entirely
    #: for a cancelled trip so it cannot drag an occupancy average.
    occupancy_rate = serializers.DecimalField(
        max_digits=5, decimal_places=3, allow_null=True
    )


class TripPunctualitySerializer(serializers.Serializer):
    """Null in full before the trip departs — a trip that has not left
    is not "0 minutes late". Measured at departure only: no scheduled
    arrival time exists anywhere in the model, which this spec names as
    a gap rather than inventing one."""

    scheduled_departure_at = serializers.DateTimeField()
    actual_departure_at = serializers.DateTimeField()
    actual_arrival_at = serializers.DateTimeField(allow_null=True)
    delay_minutes = serializers.IntegerField()
    on_time = serializers.BooleanField()


class TripMoneySerializer(serializers.Serializer):
    currency = serializers.CharField()
    revenue = serializers.DecimalField(max_digits=14, decimal_places=2)
    gross = serializers.DecimalField(max_digits=14, decimal_places=2)
    revenue_per_seat = serializers.DecimalField(
        max_digits=14, decimal_places=2, allow_null=True
    )


class TripPerformanceSerializer(serializers.Serializer):
    trip = TripPerformanceTripSerializer()
    capacity = TripCapacitySerializer()
    punctuality = TripPunctualitySerializer(allow_null=True)
    money = TripMoneySerializer(many=True)
    incidents = serializers.IntegerField()
    cancelled = serializers.BooleanField()
