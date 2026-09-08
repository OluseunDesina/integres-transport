from functools import lru_cache
from zoneinfo import available_timezones

from django.core.exceptions import ValidationError
from django.db import models

from apps.core.models import BaseModel


@lru_cache(maxsize=1)
def _iana_timezones() -> frozenset[str]:
    """`available_timezones()` walks the tzdata tree on every call, so
    cache it — this validator runs on every Business write."""
    return frozenset(available_timezones())


def validate_iana_timezone(value: str) -> None:
    """Rejects anything that isn't a real IANA zone name.

    Before this existed, `timezone` was an unvalidated free-text field:
    a typo saved cleanly and only surfaced much later as a
    `ZoneInfoNotFoundError` deep inside trip generation
    (`apps.scheduling.tasks`) or settlement-period arithmetic
    (`apps.ledger.services.claim_settlement_run`), by which point the
    bad value was already load-bearing. Validating at the boundary
    turns that into a 400 on the write that caused it.
    """
    if value not in _iana_timezones():
        raise ValidationError(
            "%(value)s is not a recognised IANA timezone name (e.g. Africa/Lagos).",
            code="invalid_timezone",
            params={"value": value},
        )


class Business(BaseModel):
    """A Client can run multiple Businesses (e.g. two shuttle operations
    in two cities) — see docs/specs/1-identity-client-business.md §2.
    KYB review is independent of the owning Client's own KYC: a Business
    may exist and be reviewed while `Client.kyc_status` is still
    `pending` (§6). `kyb_status` will gate Route/Trip creation in
    Phase 3 — the field exists for that now, nothing enforces it yet.
    """

    class Vertical(models.TextChoices):
        SHUTTLE = "shuttle", "Shuttle"
        INTERCITY = "intercity", "Intercity"
        METRO = "metro", "Metro"

    class BookingMode(models.TextChoices):
        """**What the passenger buys** — a specific seat, or just a place
        on a departure. See docs/specs/10-booking-modes.md.

        `tap_and_go` used to live here and no longer does. It was never
        a booking mode: it conflated what you buy, how you're identified
        at boarding, and when you pay. Those are now three independent
        axes — this one, `TapCredential` (usable in *any* mode), and
        `FareCollectionMode` below.
        """

        RESERVATION = "reservation", "Reservation"
        OPEN_SEATING = "open_seating", "Open seating"

    class FareCollectionMode(models.TextChoices):
        """**When the passenger pays**, and therefore how the fare is
        determined — up front for a known origin/destination, or after
        travel from recorded board/alight taps.

        Deliberately *not* named `fare_mode`: `fare_pricing_mode` below
        already exists and means *how much* (flat vs per-segment). This
        axis is *when*. Conflating the two names will cost someone an
        afternoon.
        """

        PREPAID = "prepaid", "Prepaid"
        PAY_AS_YOU_GO = "pay_as_you_go", "Pay as you go"

    class TripClass(models.TextChoices):
        """**What class of service a departure is sold as** — see
        docs/specs/15-trip-classes.md.

        Declared here alongside the three axes above rather than in
        `apps.fleet` or `apps.scheduling`, because it is read by all
        four of `fleet`/`network`/`scheduling`/`fares` and every one of
        them already imports `Business` for `BookingMode` /
        `FareCollectionMode` / `FarePricingMode`. Putting it anywhere
        else would add an import edge for nothing.

        `STANDARD` is the default everywhere and the class every
        pre-existing row backfilled to, which is what makes spec 15's
        migration behaviour-preserving.

        A `VehicleType` has exactly **one** class — mixed-class vehicles
        (business at the front, economy behind) are explicitly out of
        scope, because a per-`Seat` class would reopen ADR-0004's
        seat-segment exclusion constraint and spec 10's whole
        availability envelope.
        """

        PREMIUM = "premium", "Premium"
        EXCLUSIVE = "exclusive", "Exclusive"
        STANDARD = "standard", "Standard"
        MINI = "mini", "Mini"

    class Currency(models.TextChoices):
        """Constrained to what the platform can actually collect money in.

        The first five are Paystack's GA markets per `docs/adr/0007`;
        USD is Paystack's cross-border settlement currency. `BWP` is
        deliberately included despite Paystack not operating in
        Botswana — that ADR's explicit decision was to treat Botswana
        as a *named open gap*, not to pretend it isn't a target market,
        and silently making its operators unonboardable would
        contradict that. The client-admin UI labels it as unsupported
        for payments rather than hiding it. Revisit when the second PSP
        that ADR defers is chosen.
        """

        NGN = "NGN", "Nigerian Naira (NGN)"
        ZAR = "ZAR", "South African Rand (ZAR)"
        GHS = "GHS", "Ghanaian Cedi (GHS)"
        KES = "KES", "Kenyan Shilling (KES)"
        XOF = "XOF", "West African CFA Franc (XOF)"
        USD = "USD", "US Dollar (USD)"
        BWP = "BWP", "Botswana Pula (BWP)"

    class KybStatus(models.TextChoices):
        PENDING = "pending", "Pending"
        SUBMITTED = "submitted", "Submitted"
        APPROVED = "approved", "Approved"
        REJECTED = "rejected", "Rejected"

    class FarePricingMode(models.TextChoices):
        FLAT = "flat", "Flat"
        PER_SEGMENT = "per_segment", "Per segment"

    vertical = models.CharField(max_length=20, choices=Vertical.choices)
    name = models.CharField(max_length=255)
    # Constrained to a real choice list, not just a shape. The previous
    # RegexValidator only rejected the wrong *shape* (`Naira` vs `NGN`),
    # so a well-formed-but-unsupported code like `GBP` still saved
    # cleanly and only failed once apps.payments.psp.paystack sent it on
    # to Paystack, which rejects it with a 400 mapped to a 502 here.
    # See Currency's own docstring for why BWP is on the list anyway.
    currency = models.CharField(max_length=8, choices=Currency.choices)
    timezone = models.CharField(max_length=64, validators=[validate_iana_timezone])
    booking_mode_default = models.CharField(max_length=20, choices=BookingMode.choices)
    # docs/specs/10-booking-modes.md. Snapshotted onto every Trip at
    # creation exactly as booking_mode_default already is, so changing
    # it here only affects future Trips.
    fare_collection_mode = models.CharField(
        max_length=20,
        choices=FareCollectionMode.choices,
        default=FareCollectionMode.PREPAID,
    )
    # The two booleans below are each meaningful in exactly one booking
    # mode, and are deliberately *not* validated against it. Storing an
    # inert value is harmless and keeps a Business's settings stable
    # across a mode switch and back; the UI hides the irrelevant one
    # rather than the model rejecting it.
    #
    # seat_selection_enabled: reservation only. False is surfaced to
    # passengers as "Quick book" — a reserved seat, chosen for them.
    seat_selection_enabled = models.BooleanField(default=True)
    # capacity_enforced: open seating only. False means standing room is
    # allowed and a departure never sells out. See docs/adr/0008 for why
    # the enforced case has no database constraint behind it.
    capacity_enforced = models.BooleanField(default=True)
    is_active = models.BooleanField(default=True)
    # Phase 4 (docs/specs/4-fares-seating-booking.md §2): which of
    # apps.fares's two rule types applies to this Business's Routes,
    # selected at fare-lookup time, never stored per-Route. Client-admin
    # editable via the existing PATCH /businesses/{id}/ (business.manage)
    # — the operator's own pricing-model choice, same editability class
    # as booking_mode_default.
    fare_pricing_mode = models.CharField(
        max_length=20, choices=FarePricingMode.choices, default=FarePricingMode.FLAT
    )
    # Phase 4 Slice 2 (docs/adr/0004, docs/specs/4-fares-seating-booking.md
    # §2): how long a `seating.SeatReservation` stays `held` before the
    # Celery sweep task expires it. Deliberately NOT in BusinessSerializer's
    # writable fields — mutable only via the super-admin-only
    # PATCH /super-admin/businesses/{id}/seat-hold/ endpoint
    # (apps.businesses.views.BusinessSeatHoldView), so an operator can't
    # lengthen their own hold window against other operators' inventory
    # turnover. This is the one deliberate asymmetry with
    # fare_pricing_mode's client-editability just above.
    seat_hold_minutes = models.PositiveIntegerField(default=15)

    kyb_status = models.CharField(
        max_length=20, choices=KybStatus.choices, default=KybStatus.PENDING
    )
    kyb_submitted_at = models.DateTimeField(null=True, blank=True)
    kyb_decided_at = models.DateTimeField(null=True, blank=True)
    kyb_decided_by = models.ForeignKey(
        "identity.User", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    kyb_rejection_reason = models.TextField(blank=True)

    def __str__(self) -> str:
        return self.name


# Module-level so `ENUM_NAME_OVERRIDES` can resolve it — `import_string`
# cannot walk into a nested class. Named once here so both
# `BusinessSerializer.fare_pricing_mode` and
# `apps.network.serializers.RouteFareSummarySerializer.pricing_mode`
# (docs/specs/19-route-lifecycle.md) generate the same schema.ts type
# instead of two names for one choice set.
FARE_PRICING_MODE_CHOICES = Business.FarePricingMode.choices


class Director(BaseModel):
    """A director of a Business — see docs/specs/11-kyb-directors.md.

    Its own model rather than fields on `Business` because a Business
    routinely has several: Nigerian CAC filings commonly list two or
    more, and a single-director assumption would need unpicking almost
    immediately. Director identity is the substance of a KYB check, and
    before this existed it had nowhere to live at all — every director's
    ID went in as an undifferentiated `KybDocument` upload with no name
    or ID type attached to it.
    """

    class IdType(models.TextChoices):
        NIN = "nin", "National Identification Number (NIN)"
        PASSPORT = "passport", "International passport"
        DRIVERS_LICENCE = "drivers_licence", "Driver's licence"
        VOTERS_CARD = "voters_card", "Voter's card"

    # `client` (inherited from BaseModel) is what RLS/tenancy scopes on;
    # `business` narrows to which Business within that Client. Both
    # related_name="+" for the same reason KybDocument's own FKs are —
    # a reverse accessor would go through TenantScopedManager, which
    # silently empties for platform staff.
    business = models.ForeignKey(Business, on_delete=models.PROTECT, related_name="+")
    full_name = models.CharField(max_length=255)
    id_type = models.CharField(max_length=30, choices=IdType.choices)
    # Optional: an operator may be recording directors before they have
    # every document to hand. The platform decides sufficiency at review
    # time, not this form.
    id_number = models.CharField(max_length=50, blank=True)
    # Soft-remove, never a hard delete: a director attached to a
    # submitted or already-approved KYB packet must not vanish from the
    # record. `KybDocument.director`'s on_delete=PROTECT makes the hard
    # case raise rather than silently destroying evidence.
    is_active = models.BooleanField(default=True)

    class Meta:
        # Stated explicitly, not left to inheritance. `identity.Role` and
        # `identity.User` both silently dropped BaseModel.Meta's ordering
        # by declaring a bare Meta, which produced real unstable-
        # pagination bugs; Route.Meta's own comment documents the same
        # trap. Costs nothing here and closes it.
        ordering = ["full_name"]

    def __str__(self) -> str:
        return self.full_name


class KybDocument(BaseModel):
    class DocumentType(models.TextChoices):
        CERTIFICATE_OF_INCORPORATION = (
            "certificate_of_incorporation",
            "Certificate of incorporation",
        )
        PROOF_OF_ADDRESS = "proof_of_address", "Proof of address"
        DIRECTORS_ID = "directors_id", "Director's ID"
        TAX_CERTIFICATE = "tax_certificate", "Tax certificate"
        OTHER = "other", "Other"

    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        APPROVED = "approved", "Approved"
        REJECTED = "rejected", "Rejected"

    # `client` (inherited from BaseModel) is what RLS/tenancy scopes on;
    # `business` narrows to which Business within that Client this
    # document is for. related_name="+" on both, deliberately — see
    # apps.clients.models.KycDocument's precedent and this slice's plan:
    # a reverse accessor on an RLS-protected model would go through the
    # same TenantScopedManager that silently empties for platform staff.
    business = models.ForeignKey(Business, on_delete=models.PROTECT, related_name="+")
    # Set only for a director's ID document; null for company-level
    # documents (CAC certificate, proof of address, tax certificate,
    # other). PROTECT, not CASCADE — deleting a director must never
    # silently take their ID document with it; see Director.is_active.
    director = models.ForeignKey(
        Director, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    document_type = models.CharField(max_length=40, choices=DocumentType.choices)
    file = models.FileField(upload_to="kyb-documents/%Y/%m/")
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.PENDING)
    reviewed_by = models.ForeignKey(
        "identity.User", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    reviewed_at = models.DateTimeField(null=True, blank=True)
    rejection_reason = models.TextField(blank=True)

    def __str__(self) -> str:
        return f"{self.get_document_type_display()} ({self.business_id})"
