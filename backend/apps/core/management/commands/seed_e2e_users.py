"""Creates a fixed set of test accounts for Playwright e2e runs.

This is test infrastructure, not the "demo seed data per vertical"
product feature described in the brief (that command doesn't exist yet —
there are no business models to seed until Phase 1). Idempotent: safe to
run repeatedly against a persistent dev database.
"""

import datetime
import hashlib
from decimal import Decimal
from typing import Any

from django.core.files.base import ContentFile
from django.core.management.base import BaseCommand
from django.utils import timezone

from apps.businesses.models import Business, Director, KybDocument
from apps.businesses.services import create_business, create_director, submit_kyb_document
from apps.clients.models import Client, KycDocument
from apps.clients.services import submit_kyc_document
from apps.core.context import reset_current_client_id, set_current_client_id
from apps.core.rls import platform_staff_bypass
from apps.fares.models import FareRule
from apps.fares.services import create_fare_rule
from apps.fleet.models import Vehicle, VehicleType
from apps.fleet.services import create_vehicle, create_vehicle_type
from apps.identity.models import User
from apps.identity.services import create_default_roles
from apps.incidents.models import Incident
from apps.network.models import Route, Stop
from apps.network.services import create_route, create_stop, set_route_status, set_route_stops
from apps.scheduling.models import Trip
from apps.scheduling.services import create_manual_trip
from apps.seating.models import Seat
from apps.seating.services import generate_seat_layout, replace_vehicle_type_seats
from apps.tapngo.models import TapCredential

E2E_PASSWORD = "e2e-test-password-123"  # noqa: S105

# Fixed so the incidents e2e spec can find this row by name — see
# `_seed_incident_fixture`.
E2E_INCIDENT_REFERENCE = "INC-E2E001"

# Named so `prune_e2e_test_data` (which only ever touches rows under
# this one Client) imports the same literal rather than duplicating it —
# the two commands drifting apart on what "the e2e Client" means would
# be a real bug (an accidental prune of the wrong Client, or a stray
# fixture the pruner doesn't recognize as real).
E2E_CLIENT_NAME = "Integra E2E Test Client"
NETWORK_BUSINESS_NAME = "Integra E2E Network Test Business"
KYB_BUSINESS_NAME = "Integra E2E KYB Review Business"
# A director on that same packet, so the KYB queue's Directors column
# (docs/specs/11-kyb-directors.md) has a known name to assert on.
KYB_DIRECTOR_NAME = "Amara Nwosu"

# The bookable fixture below. Named constants so the e2e specs and a
# human clicking through the customer app can both find the same rows.
BOOKABLE_ROUTE_NAME = "Ikeja → CMS"
BOOKABLE_STOP_NAMES = ["Ikeja", "Yaba", "CMS"]
BOOKABLE_VEHICLE_TYPE_NAME = "E2E Shuttle Bus"
BOOKABLE_SEAT_NUMBERS = ["1A", "1B", "2A", "2B", "3A", "3B"]
BOOKABLE_REGISTRATION = "E2E-1234-LA"
BOOKABLE_FARE = Decimal("750.00")
BOOKABLE_DEPARTURE_TIME = datetime.time(6, 30)
# Trips are seeded for today plus the next week rather than a fixed
# date: a demo or e2e run on any day must find something to book, and a
# hard-coded date silently stops being searchable the day after it
# passes.
BOOKABLE_TRIP_DAYS = 8

# The service-class half of that same fixture
# (docs/specs/15-trip-classes.md slice 3). Deliberately on the *same*
# Route and the *same* dates as the Standard departures above: the point
# a passenger-facing class test has to prove is that one route offers
# two classes at two prices, and that the filter picks between them.
# That cannot be shown on a route that runs one class.
#
# The departure time is later than BOOKABLE_DEPARTURE_TIME on purpose.
# `Trip.Meta.ordering` is ("service_date", "scheduled_departure_at"), so
# the Standard trip stays first in the results and the three existing
# specs that click the first Continue keep selecting the trip they were
# written against.
BOOKABLE_PREMIUM_VEHICLE_TYPE_NAME = "E2E Premium Coach"
BOOKABLE_PREMIUM_REGISTRATION = "E2E-9876-LA"
BOOKABLE_PREMIUM_FARE = Decimal("1250.00")
BOOKABLE_PREMIUM_DEPARTURE_TIME = datetime.time(18, 45)
# Narrower than "every class", so the route also exercises the
# allow-list: a passenger sees Premium and Standard, not all four.
BOOKABLE_TRIP_CLASSES = [Business.TripClass.PREMIUM, Business.TripClass.STANDARD]

# The tap fixture below, for validator-app's e2e coverage
# (docs/specs/4b-tap-and-go.md). A separate Business from the bookable
# fixture above — both mode fields are snapshotted per-Trip from the
# Business (`apps.scheduling.services.create_manual_trip`), not settable
# per-Trip, so a pay-as-you-go Trip needs its own Business.
#
# The names still say "Tap & Go" on purpose. `tap_and_go` stopped being
# a booking mode in docs/specs/10-booking-modes.md — this Business is
# now `open_seating` + `pay_as_you_go` — but what the fixture exercises
# is the tap *credential*, which is the half that genuinely stayed
# universal. See _seed_tap_and_go_fixture's own docstring.
TAP_AND_GO_BUSINESS_NAME = "Integra E2E Tap & Go Business"
TAP_AND_GO_ROUTE_NAME = "CBD Loop"
TAP_AND_GO_STOP_NAMES = ["Gate A", "Mid Stop", "Gate B"]
TAP_AND_GO_VEHICLE_TYPE_NAME = "E2E Tap & Go Shuttle"
TAP_AND_GO_REGISTRATION = "E2E-5678-LA"
TAP_AND_GO_FARE = Decimal("300.00")
TAP_AND_GO_DEPARTURE_TIME = datetime.time(7, 0)
TAP_AND_GO_TRIP_DAYS = 8
# `TapCredential.token` is never persisted (only its SHA-256 `token_hash`
# is — `apps.tapngo.services.issue_credential` returns the raw token
# exactly once and never again), so an e2e spec needs a credential
# seeded directly from a known constant rather than issued through the
# normal flow. Mirrors E2E_PASSWORD's own "fixed constant, hashed at
# rest" shape.
TAP_CREDENTIAL_TOKEN = "e2e-tap-credential-fixed-token"  # noqa: S105
TAP_CREDENTIAL_LABEL = "E2E fixed credential"

# Fixture for the fare-grid e2e (docs/specs/12-fare-matrix.md). Its own
# Business for the same reason the tap-and-go fixture has one:
# `fare_pricing_mode` is per-Business and `get_fare()` reads it at
# lookup time, so flipping the shared bookable Business to per-segment
# would break every other spec that relies on its flat fare.
#
# Deliberately seeds **no** fare rows at all — pricing this route
# through the grid is what the spec is testing, and a pre-priced route
# would let it pass without the grid ever working.
PER_SEGMENT_BUSINESS_NAME = "Integra E2E Per-Segment Fare Business"
PER_SEGMENT_ROUTE_NAME = "Apapa → Ojota"
PER_SEGMENT_STOP_NAMES = ["Apapa", "Surulere", "Ojota"]
PER_SEGMENT_VEHICLE_TYPE_NAME = "E2E Per-Segment Shuttle"
PER_SEGMENT_REGISTRATION = "E2E-9012-LA"
PER_SEGMENT_DEPARTURE_TIME = datetime.time(8, 0)
PER_SEGMENT_TRIP_DAYS = 8

# Fixture for the open-seating purchase e2e
# (docs/specs/10-booking-modes.md slice 4). Its own Business for the
# same reason the two above have one: `booking_mode` is snapshotted
# per-Trip from the Business, so open seating cannot share the bookable
# fixture's reservation-mode Trips.
#
# **Prepaid** open seating — the combination the spec was written for:
# pay up front for an origin and destination, get a ticket, sit
# anywhere. Not to be confused with the tap-and-go fixture above, which
# is open seating *and* pay-as-you-go.
OPEN_SEATING_BUSINESS_NAME = "Integra E2E Open Seating Business"
OPEN_SEATING_ROUTE_NAME = "Yaba → Lekki"
OPEN_SEATING_STOP_NAMES = ["Yaba", "Obalende", "Lekki"]
# Real Lagos coordinates, in the same order as the names above — this is
# the **only** coordinated route in the e2e fixtures, deliberately.
# docs/specs/20-live-operations.md's simulator and progress/ETA
# computation both require `Stop.latitude`/`longitude`
# ("route with uncoordinated stops" is its own documented edge case),
# and every other seeded route leaves both `None`. Without one real
# route here, `simulate_vehicle_positions` skips every trip and the
# live-operations e2e spec has nothing to assert against.
OPEN_SEATING_STOP_COORDINATES = [
    (Decimal("6.515800"), Decimal("3.370700")),  # Yaba
    (Decimal("6.450000"), Decimal("3.406700")),  # Obalende
    (Decimal("6.448800"), Decimal("3.472600")),  # Lekki
]
OPEN_SEATING_VEHICLE_TYPE_NAME = "E2E Open Seating Coach"
OPEN_SEATING_REGISTRATION = "E2E-3456-LA"
OPEN_SEATING_FARE = Decimal("900.00")
OPEN_SEATING_DEPARTURE_TIME = datetime.time(9, 30)
OPEN_SEATING_TRIP_DAYS = 8
# Deliberately generous. Capacity counts issued tickets, and every e2e
# run that pays leaves more behind — a small vehicle would quietly turn
# this fixture into a sold-out one after a few dozen runs, and the spec
# would start failing for a reason that looks nothing like its cause.
OPEN_SEATING_CAPACITY = 400
# A paid open-seating booking is seeded too, so the validator e2e has a
# real seatless Ticket to scan. It cannot come from the UI: paying
# leaves the app for Paystack, which no browser test can complete.
OPEN_SEATING_TICKET_PASSENGERS = 1


class Command(BaseCommand):
    help = "Seed fixed passenger/client-staff/platform-staff accounts for Playwright e2e runs."

    def handle(self, *args: Any, **options: Any) -> None:
        client, _ = Client.objects.get_or_create(name=E2E_CLIENT_NAME)

        passenger, _ = User.objects.get_or_create(
            email="e2e-passenger@example.com",
            client=client,
            defaults={"is_client_staff": False, "is_platform_staff": False},
        )
        passenger.set_password(E2E_PASSWORD)
        passenger.save()

        # Owner role (all seeded permissions) — without this, /me's
        # permissions array is just ["client-admin:access"], and every
        # client.view/business.manage-gated screen (Phase 2 Slice 1+) is
        # unreachable for this account. See create_default_roles's own
        # idempotency note; safe to call on every seed run.
        roles = create_default_roles(client)
        client_staff, _ = User.objects.get_or_create(
            email="e2e-client-staff@example.com",
            client=client,
            defaults={"is_client_staff": True, "is_platform_staff": False, "role": roles["Owner"]},
        )
        client_staff.role = roles["Owner"]
        client_staff.set_password(E2E_PASSWORD)
        client_staff.save()

        # A second, distinct staff member — Phase 2 Slice 2's staff-list
        # e2e coverage edits a row's role/active status inline, and doing
        # that against the signed-in e2e user's own row risks losing the
        # very permissions the rest of the session depends on
        # (staff.manage/staff.invite are Owner-only; a self-downgrade
        # can't be undone by that same, now-downgraded session). This
        # account exists purely to be someone else's row to edit.
        colleague, _ = User.objects.get_or_create(
            email="e2e-client-staff-colleague@example.com",
            client=client,
            defaults={
                "is_client_staff": True,
                "is_platform_staff": False,
                "role": roles["Staff"],
            },
        )
        colleague.role = roles["Staff"]
        colleague.is_active = True
        colleague.set_password(E2E_PASSWORD)
        colleague.save()

        platform_staff, _ = User.objects.get_or_create(
            email="e2e-platform-staff@example.com",
            client=None,
            defaults={"is_platform_staff": True, "is_staff": True},
        )
        platform_staff.set_password(E2E_PASSWORD)
        platform_staff.save()

        # A Client and a Business permanently sitting in `submitted` KYC/KYB
        # status, so Phase 2 Slice 3's KYC/KYB queue e2e specs always have
        # something to review. `submit_kyc_document`/`submit_kyb_document`
        # write BaseModel/RLS-protected rows outside any HTTP request, so
        # they need platform_staff_bypass() here — same requirement
        # CLAUDE.md documents for any management command touching these
        # models (see create_default_roles's own docstring for the same
        # pattern). Status is force-reset to `submitted` on every seed run
        # (not just when first created) so a prior e2e run's own
        # approve/reject decision doesn't leave the queue empty next time —
        # this is test setup, not exercising the real KYC/KYB state machine.
        with platform_staff_bypass():
            kyc_client, _ = Client.objects.get_or_create(
                email="e2e-kyc-review@example.com",
                defaults={"name": "Integra E2E KYC Review Client"},
            )
            if not KycDocument.all_objects.filter(client=kyc_client).exists():
                submit_kyc_document(
                    client=kyc_client,
                    document_type=KycDocument.DocumentType.CERTIFICATE_OF_INCORPORATION,
                    file=ContentFile(b"e2e-test-certificate", name="certificate.pdf"),
                    uploaded_by=client_staff,
                )

            kyb_business = Business.all_objects.filter(
                client=client, name=KYB_BUSINESS_NAME
            ).first()
            if kyb_business is None:
                kyb_business = create_business(
                    client=client,
                    vertical=Business.Vertical.SHUTTLE,
                    name=KYB_BUSINESS_NAME,
                    currency="NGN",
                    timezone_name="Africa/Lagos",
                    booking_mode_default=Business.BookingMode.RESERVATION,
                    created_by=client_staff,
                )
            # A director on the packet, so the KYB queue's own Directors
            # column has something to assert against — docs/specs/
            # 11-kyb-directors.md's test plan. Reviewing a business means
            # reviewing who is behind it, so an all-empty column would
            # leave the column's whole reason for existing untested.
            kyb_director = Director.all_objects.filter(
                business=kyb_business, full_name=KYB_DIRECTOR_NAME
            ).first()
            if kyb_director is None:
                kyb_director = create_director(
                    business=kyb_business,
                    full_name=KYB_DIRECTOR_NAME,
                    id_type=Director.IdType.NIN,
                    id_number="12345678901",
                    created_by=client_staff,
                )

            if not KybDocument.all_objects.filter(business=kyb_business).exists():
                submit_kyb_document(
                    business=kyb_business,
                    document_type=KybDocument.DocumentType.CERTIFICATE_OF_INCORPORATION,
                    file=ContentFile(b"e2e-test-certificate", name="certificate.pdf"),
                    uploaded_by=client_staff,
                )
                # A director's ID, linked to that director rather than
                # dropped into the company-level pile — the distinction
                # spec 11 exists to make.
                submit_kyb_document(
                    business=kyb_business,
                    document_type=KybDocument.DocumentType.DIRECTORS_ID,
                    file=ContentFile(b"e2e-test-director-id", name="director-id.pdf"),
                    uploaded_by=client_staff,
                    director=kyb_director,
                )

            # Business is RLS-protected, so this reset must stay inside the
            # bypass too — outside it, the UPDATE is silently blocked by RLS
            # (0 rows affected), which Django's update_fields save() then
            # raises as Business.NotUpdated. Client isn't RLS-protected, so
            # its own reset doesn't strictly need to be in here, but keeping
            # both together avoids relying on that distinction implicitly.
            kyc_client.kyc_status = Client.KycStatus.SUBMITTED
            kyc_client.kyc_submitted_at = timezone.now()
            kyc_client.save(update_fields=["kyc_status", "kyc_submitted_at"])

            kyb_business.kyb_status = Business.KybStatus.SUBMITTED
            kyb_business.kyb_submitted_at = timezone.now()
            kyb_business.save(update_fields=["kyb_status", "kyb_submitted_at"])

            # Phase 3's network e2e specs (routes/stops) need a Business
            # that's already KYB-approved — Route creation is gated on
            # that (docs/specs/3-network-scheduling-fleet.md §6) and
            # nothing in this seed script otherwise produces one.
            # Permanently reset to approved on every run for the same
            # reason kyb_business is force-reset above: a prior e2e run's
            # own actions must never leave this account without a usable
            # fixture next time.
            network_business = Business.all_objects.filter(
                client=client, name=NETWORK_BUSINESS_NAME
            ).first()
            if network_business is None:
                network_business = create_business(
                    client=client,
                    vertical=Business.Vertical.SHUTTLE,
                    name=NETWORK_BUSINESS_NAME,
                    currency="NGN",
                    timezone_name="Africa/Lagos",
                    booking_mode_default=Business.BookingMode.RESERVATION,
                    created_by=client_staff,
                )
            network_business.kyb_status = Business.KybStatus.APPROVED
            network_business.save(update_fields=["kyb_status"])

            self._seed_bookable_journey(business=network_business, actor=client_staff)
            self._seed_tap_and_go_fixture(client=client, actor=client_staff, passenger=passenger)
            self._seed_per_segment_fare_fixture(client=client, actor=client_staff)
            self._seed_open_seating_fixture(
                client=client, actor=client_staff, passenger=passenger
            )
            self._seed_incident_fixture(business=network_business, actor=client_staff)

        self.stdout.write(self.style.SUCCESS("Seeded e2e test users."))

    def _seed_incident_fixture(self, *, business: Business, actor: User) -> None:
        """One open incident with a fixed reference, for the client-admin
        incidents e2e spec — docs/specs/17-incidents.md.

        The reference is hardcoded rather than generated. `create_incident`
        picks a random Crockford-base32 suffix by design (a per-tenant
        counter would need a lock and would leak volume), so a spec that
        wanted to find "the seeded incident" could not name it. The row is
        written directly for the same reason the tap-and-go fixture writes
        its own token: the real flow cannot produce a value a spec can
        predict.

        `get_or_create` keeps this command's standing "never deletes,
        always safe to re-run" guarantee — the spec transitions this row,
        so a second run must not file a second copy.
        """
        Incident.all_objects.get_or_create(
            business=business,
            reference=E2E_INCIDENT_REFERENCE,
            defaults={
                "client_id": business.client_id,
                "title": "Card reader unresponsive on the morning run",
                "description": "Reported by the driver — no lights, no beep.",
                "category": Incident.Category.HARDWARE,
                "severity": Incident.Severity.HIGH,
                "status": Incident.Status.OPEN,
                "source": Incident.Source.OPERATOR,
                "device_reference": "VLD-E2E-01",
                "reported_by": actor,
            },
        )

    def _seed_bookable_journey(self, *, business: Business, actor: User) -> None:
        """Everything Phase 4's customer booking flow needs to render
        something real: a Route with three active Stops, a VehicleType
        with seats, a Vehicle, a flat fare, and a week of scheduled
        Trips.

        Without this the flow is reachable but empty — `GET
        /routes/browse/` requires >=2 active Stops, the seat picker
        requires an assigned Vehicle whose VehicleType has Seats, and it
        blocks entirely on an unpriced segment. None of fares or seats
        has a client-admin screen yet (that's out of scope for the
        frontend addendum), so seeding is the only way to produce them
        outside the API.

        Idempotent like the rest of this command: every row is looked up
        by its natural key first, so repeated runs neither duplicate nor
        reset a booking made against a previous run.
        """
        route = Route.all_objects.filter(business=business, name=BOOKABLE_ROUTE_NAME).first()
        if route is None:
            route = create_route(
                business=business,
                name=BOOKABLE_ROUTE_NAME,
                code="IKJ-CMS",
                description="Seeded demo route for the passenger booking flow.",
                created_by=actor,
            )

        stops: list[Stop] = []
        for name in BOOKABLE_STOP_NAMES:
            stop = Stop.all_objects.filter(business=business, name=name).first()
            if stop is None:
                stop = create_stop(
                    business=business,
                    name=name,
                    address=f"{name}, Lagos",
                    latitude=None,
                    longitude=None,
                    created_by=actor,
                )
            stops.append(stop)
        set_route_stops(route=route, stops=stops, updated_by=actor)

        vehicle_type = VehicleType.all_objects.filter(
            business=business, name=BOOKABLE_VEHICLE_TYPE_NAME
        ).first()
        if vehicle_type is None:
            vehicle_type = create_vehicle_type(
                business=business,
                name=BOOKABLE_VEHICLE_TYPE_NAME,
                capacity=len(BOOKABLE_SEAT_NUMBERS),
                created_by=actor,
            )
        # replace_vehicle_type_seats() hard-deletes and recreates, which
        # would cascade away any SeatReservation from an earlier run —
        # so only seed seats when there are none. 3 rows x 2 columns
        # under the row_letter scheme produces exactly
        # BOOKABLE_SEAT_NUMBERS ("1A".."3B") — real geometry now, not a
        # flat list, so this fixture also exercises row/column.
        if not Seat.all_objects.filter(vehicle_type=vehicle_type).exists():
            layout = generate_seat_layout(
                rows=3, columns=2, aisle_after_column=None, numbering_scheme="row_letter"
            )
            replace_vehicle_type_seats(
                vehicle_type=vehicle_type,
                seats=layout,
                updated_by=actor,
            )

        vehicle = Vehicle.all_objects.filter(
            business=business, registration_number=BOOKABLE_REGISTRATION
        ).first()
        if vehicle is None:
            vehicle = create_vehicle(
                business=business,
                vehicle_type=vehicle_type,
                registration_number=BOOKABLE_REGISTRATION,
                insurance_expires_at=None,
                roadworthiness_expires_at=None,
                created_by=actor,
            )

        if not FareRule.all_objects.filter(business=business, route=route).exists():
            create_fare_rule(business=business, route=route, amount=BOOKABLE_FARE, created_by=actor)

        # docs/specs/19-route-lifecycle.md: `create_route` defaults every
        # new Route to `draft`, and both `RouteBrowseView` and
        # `find_route_stop_matches` (the passenger-facing search this
        # fixture exists to feed) require `active` — a route this
        # command re-creates after a wipe would otherwise sit forever in
        # a status neither is willing to show. `set_route_status` is a
        # no-op once already active, so this is safe on every run.
        #
        # Unlike every other call in this file, this one needs
        # `set_current_client_id` around it: `set_route_status`'s own
        # activation guard reads `RouteStop.objects`/`route_fare_summary`
        # (tenant-scoped, contextvar-driven), not `all_objects` — the
        # same trap `_seed_boardable_open_seating_ticket` hits calling
        # `create_booking`, and `platform_staff_bypass()`'s own docstring
        # is explicit that it never touches this contextvar, only the
        # Postgres GUCs.
        if route.status == Route.Status.DRAFT:
            client_token = set_current_client_id(str(business.client_id))
            try:
                set_route_status(route=route, new_status=Route.Status.ACTIVE, actor=actor)
            finally:
                reset_current_client_id(client_token)

        # docs/specs/15-trip-classes.md slice 3 — a second class on this
        # same Route, so the passenger app has two prices to tell apart.
        #
        # Set unconditionally rather than only at creation: a database
        # seeded before this spec has a Route with an empty allow-list,
        # and re-running the command has to bring it forward. Narrowing
        # never invalidates an existing Schedule (this spec's own edge
        # case table), and both classes seeded here are in the list.
        if list(route.available_trip_classes) != list(BOOKABLE_TRIP_CLASSES):
            route.available_trip_classes = list(BOOKABLE_TRIP_CLASSES)
            route.save(update_fields=["available_trip_classes"])

        premium_vehicle_type = VehicleType.all_objects.filter(
            business=business, name=BOOKABLE_PREMIUM_VEHICLE_TYPE_NAME
        ).first()
        if premium_vehicle_type is None:
            premium_vehicle_type = create_vehicle_type(
                business=business,
                name=BOOKABLE_PREMIUM_VEHICLE_TYPE_NAME,
                capacity=len(BOOKABLE_SEAT_NUMBERS),
                created_by=actor,
                trip_class=Business.TripClass.PREMIUM,
            )
        # Same "only when there are none" guard as the Standard type
        # above, and for the same reason: replace_vehicle_type_seats()
        # hard-deletes, which would cascade away a SeatReservation made
        # against a previous run.
        if not Seat.all_objects.filter(vehicle_type=premium_vehicle_type).exists():
            replace_vehicle_type_seats(
                vehicle_type=premium_vehicle_type,
                seats=generate_seat_layout(
                    rows=3, columns=2, aisle_after_column=None, numbering_scheme="row_letter"
                ),
                updated_by=actor,
            )

        premium_vehicle = Vehicle.all_objects.filter(
            business=business, registration_number=BOOKABLE_PREMIUM_REGISTRATION
        ).first()
        if premium_vehicle is None:
            premium_vehicle = create_vehicle(
                business=business,
                vehicle_type=premium_vehicle_type,
                registration_number=BOOKABLE_PREMIUM_REGISTRATION,
                insurance_expires_at=None,
                roadworthiness_expires_at=None,
                created_by=actor,
            )

        # Filtered by class, not just by route: the wildcard rule seeded
        # above already matches `business + route`, so the unqualified
        # check would see it and skip this one forever — leaving the
        # Premium trips priced from the wildcard, which is the exact
        # thing the class test exists to disprove.
        if not FareRule.all_objects.filter(
            business=business, route=route, trip_class=Business.TripClass.PREMIUM
        ).exists():
            create_fare_rule(
                business=business,
                route=route,
                amount=BOOKABLE_PREMIUM_FARE,
                created_by=actor,
                trip_class=Business.TripClass.PREMIUM,
            )

        today = timezone.localdate()
        for offset in range(BOOKABLE_TRIP_DAYS):
            service_date = today + datetime.timedelta(days=offset)
            for trip_class, trip_vehicle, departure_time in (
                (Business.TripClass.STANDARD, vehicle, BOOKABLE_DEPARTURE_TIME),
                (
                    Business.TripClass.PREMIUM,
                    premium_vehicle,
                    BOOKABLE_PREMIUM_DEPARTURE_TIME,
                ),
            ):
                if Trip.all_objects.filter(
                    route=route, service_date=service_date, trip_class=trip_class
                ).exists():
                    continue
                create_manual_trip(
                    route=route,
                    service_date=service_date,
                    departure_time=departure_time,
                    vehicle=trip_vehicle,
                    driver=None,
                    created_by=actor,
                    trip_class=trip_class,
                )

    def _seed_per_segment_fare_fixture(self, *, client: Client, actor: User) -> None:
        """Everything the fare-grid e2e needs to price a route and then
        book against the result: a per-segment-priced Business, a
        three-stop Route, a VehicleType with Seats, a Vehicle, and a
        week of Trips.

        The one thing it deliberately does **not** seed is a fare. The
        spec prices this route through the grid and then books a
        segment; seeding a fare first would let it pass with a broken
        grid.

        `fare_pricing_mode` is force-reset on every run, like the
        KYC/KYB statuses above: a manual QA session that flipped this
        Business back to flat must not leave the next run without a
        usable fixture.

        Idempotent like its two siblings — every row is looked up by its
        natural key first, so a repeated run never duplicates and never
        discards a previous run's prices.
        """
        business = Business.all_objects.filter(
            client=client, name=PER_SEGMENT_BUSINESS_NAME
        ).first()
        if business is None:
            business = create_business(
                client=client,
                vertical=Business.Vertical.SHUTTLE,
                name=PER_SEGMENT_BUSINESS_NAME,
                currency="NGN",
                timezone_name="Africa/Lagos",
                booking_mode_default=Business.BookingMode.RESERVATION,
                created_by=actor,
                fare_pricing_mode=Business.FarePricingMode.PER_SEGMENT,
            )
        business.kyb_status = Business.KybStatus.APPROVED
        business.fare_pricing_mode = Business.FarePricingMode.PER_SEGMENT
        business.save(update_fields=["kyb_status", "fare_pricing_mode"])

        route = Route.all_objects.filter(business=business, name=PER_SEGMENT_ROUTE_NAME).first()
        if route is None:
            route = create_route(
                business=business,
                name=PER_SEGMENT_ROUTE_NAME,
                code="APA-OJO",
                description="Seeded demo route for the stop-pair fare grid.",
                created_by=actor,
            )

        stops: list[Stop] = []
        for name in PER_SEGMENT_STOP_NAMES:
            stop = Stop.all_objects.filter(business=business, name=name).first()
            if stop is None:
                stop = create_stop(
                    business=business,
                    name=name,
                    address=f"{name}, Lagos",
                    latitude=None,
                    longitude=None,
                    created_by=actor,
                )
            stops.append(stop)
        set_route_stops(route=route, stops=stops, updated_by=actor)

        vehicle_type = VehicleType.all_objects.filter(
            business=business, name=PER_SEGMENT_VEHICLE_TYPE_NAME
        ).first()
        if vehicle_type is None:
            vehicle_type = create_vehicle_type(
                business=business,
                name=PER_SEGMENT_VEHICLE_TYPE_NAME,
                capacity=len(BOOKABLE_SEAT_NUMBERS),
                created_by=actor,
            )
        # Same "only when there are none" guard as _seed_bookable_journey:
        # replace_vehicle_type_seats() hard-deletes, which would cascade
        # away a SeatReservation from an earlier run.
        if not Seat.all_objects.filter(vehicle_type=vehicle_type).exists():
            replace_vehicle_type_seats(
                vehicle_type=vehicle_type,
                seats=generate_seat_layout(
                    rows=3, columns=2, aisle_after_column=None, numbering_scheme="row_letter"
                ),
                updated_by=actor,
            )

        vehicle = Vehicle.all_objects.filter(
            business=business, registration_number=PER_SEGMENT_REGISTRATION
        ).first()
        if vehicle is None:
            vehicle = create_vehicle(
                business=business,
                vehicle_type=vehicle_type,
                registration_number=PER_SEGMENT_REGISTRATION,
                insurance_expires_at=None,
                roadworthiness_expires_at=None,
                created_by=actor,
            )

        today = timezone.localdate()
        for offset in range(PER_SEGMENT_TRIP_DAYS):
            service_date = today + datetime.timedelta(days=offset)
            if Trip.all_objects.filter(route=route, service_date=service_date).exists():
                continue
            create_manual_trip(
                route=route,
                service_date=service_date,
                departure_time=PER_SEGMENT_DEPARTURE_TIME,
                vehicle=vehicle,
                driver=None,
                created_by=actor,
            )

    def _seed_tap_and_go_fixture(self, *, client: Client, actor: User, passenger: User) -> None:
        """Everything validator-app's `record-tap` e2e spec needs: a
        **pay-as-you-go** Business (a separate Business from the bookable
        fixture above, since both mode fields are snapshotted per-Trip
        from the Business at creation time — see
        `apps.scheduling.services.create_manual_trip`), a Route with
        Stops, a Vehicle, a flat fare, a week of Trips, and a
        `TapCredential` with a known, fixed raw token a Playwright spec
        can type into the form.

        The fixture keeps its "Tap & Go" name deliberately, even though
        `tap_and_go` is no longer a booking mode
        (docs/specs/10-booking-modes.md). What it exercises is the tap
        *credential* flow, and the credential is exactly the half that
        stayed universal — the name is still accurate, and renaming it
        would churn `prune_e2e_test_data` and the validator e2e specs
        for nothing.

        Idempotent like `_seed_bookable_journey`: every row is looked up
        by its natural key first.
        """
        business = Business.all_objects.filter(client=client, name=TAP_AND_GO_BUSINESS_NAME).first()
        if business is None:
            business = create_business(
                client=client,
                vertical=Business.Vertical.SHUTTLE,
                name=TAP_AND_GO_BUSINESS_NAME,
                currency="NGN",
                timezone_name="Africa/Lagos",
                booking_mode_default=Business.BookingMode.OPEN_SEATING,
                fare_collection_mode=Business.FareCollectionMode.PAY_AS_YOU_GO,
                created_by=actor,
            )
        # Route creation is gated on an approved Business, same reason
        # `network_business` is force-reset above. `fare_collection_mode`
        # is force-reset for the same self-healing reason: a manual QA
        # session that flipped it must not leave the next run without a
        # usable tap fixture.
        business.kyb_status = Business.KybStatus.APPROVED
        business.fare_collection_mode = Business.FareCollectionMode.PAY_AS_YOU_GO
        business.save(update_fields=["kyb_status", "fare_collection_mode"])

        route = Route.all_objects.filter(business=business, name=TAP_AND_GO_ROUTE_NAME).first()
        if route is None:
            route = create_route(
                business=business,
                name=TAP_AND_GO_ROUTE_NAME,
                code="TNG-1",
                description="Seeded demo route for the tap-and-go validator flow.",
                created_by=actor,
            )

        stops: list[Stop] = []
        for name in TAP_AND_GO_STOP_NAMES:
            stop = Stop.all_objects.filter(business=business, name=name).first()
            if stop is None:
                stop = create_stop(
                    business=business,
                    name=name,
                    address=f"{name}, Lagos",
                    latitude=None,
                    longitude=None,
                    created_by=actor,
                )
            stops.append(stop)
        set_route_stops(route=route, stops=stops, updated_by=actor)

        vehicle_type = VehicleType.all_objects.filter(
            business=business, name=TAP_AND_GO_VEHICLE_TYPE_NAME
        ).first()
        if vehicle_type is None:
            # No Seats needed — tap-and-go never touches apps.seating.
            vehicle_type = create_vehicle_type(
                business=business,
                name=TAP_AND_GO_VEHICLE_TYPE_NAME,
                capacity=20,
                created_by=actor,
            )

        vehicle = Vehicle.all_objects.filter(
            business=business, registration_number=TAP_AND_GO_REGISTRATION
        ).first()
        if vehicle is None:
            vehicle = create_vehicle(
                business=business,
                vehicle_type=vehicle_type,
                registration_number=TAP_AND_GO_REGISTRATION,
                insurance_expires_at=None,
                roadworthiness_expires_at=None,
                created_by=actor,
            )

        if not FareRule.all_objects.filter(business=business, route=route).exists():
            create_fare_rule(
                business=business, route=route, amount=TAP_AND_GO_FARE, created_by=actor
            )

        today = timezone.localdate()
        for offset in range(TAP_AND_GO_TRIP_DAYS):
            service_date = today + datetime.timedelta(days=offset)
            if Trip.all_objects.filter(route=route, service_date=service_date).exists():
                continue
            create_manual_trip(
                route=route,
                service_date=service_date,
                departure_time=TAP_AND_GO_DEPARTURE_TIME,
                vehicle=vehicle,
                driver=None,
                created_by=actor,
            )

        credential = TapCredential.all_objects.filter(
            client=client, passenger=passenger, label=TAP_CREDENTIAL_LABEL
        ).first()
        if credential is None:
            TapCredential.objects.create(
                client=client,
                passenger=passenger,
                token_hash=hashlib.sha256(TAP_CREDENTIAL_TOKEN.encode()).hexdigest(),
                channel=TapCredential.Channel.QR,
                label=TAP_CREDENTIAL_LABEL,
                is_active=True,
            )
        elif not credential.is_active:
            # Self-healing if a prior manual QA session revoked it —
            # same "force back to a known-good state on every run"
            # reasoning as the KYC/KYB status resets above.
            credential.is_active = True
            credential.save(update_fields=["is_active"])

    def _seed_open_seating_fixture(
        self, *, client: Client, actor: User, passenger: User
    ) -> None:
        """A **prepaid open-seating** Business, for the purchase-to-scan
        e2e in docs/specs/10-booking-modes.md slice 4.

        Its own Business, like every other fixture here, because
        `booking_mode` is snapshotted per-Trip at creation
        (`apps.scheduling.services.create_manual_trip`) and cannot vary
        within one Business.

        Distinct from `_seed_tap_and_go_fixture`, which is *also* open
        seating but pay-as-you-go. This one is the combination the spec
        exists for: pay up front for a journey, get a ticket, sit
        anywhere. A vehicle is assigned because open-seating capacity is
        read through it — without one the trip is `not_configured` and
        nothing is bookable at all.

        No Seats are created: open seating has none, and creating them
        would make the fixture quietly exercise the reservation path.

        Idempotent like its siblings: every row is looked up by its
        natural key first.
        """
        business = Business.all_objects.filter(
            client=client, name=OPEN_SEATING_BUSINESS_NAME
        ).first()
        if business is None:
            business = create_business(
                client=client,
                vertical=Business.Vertical.INTERCITY,
                name=OPEN_SEATING_BUSINESS_NAME,
                currency="NGN",
                timezone_name="Africa/Lagos",
                booking_mode_default=Business.BookingMode.OPEN_SEATING,
                fare_collection_mode=Business.FareCollectionMode.PREPAID,
                created_by=actor,
            )
        # Force-reset for the same self-healing reason the siblings give:
        # a manual QA session that flipped either field must not leave
        # the next run without a usable fixture.
        business.kyb_status = Business.KybStatus.APPROVED
        business.booking_mode_default = Business.BookingMode.OPEN_SEATING
        business.fare_collection_mode = Business.FareCollectionMode.PREPAID
        business.capacity_enforced = True
        business.save(
            update_fields=[
                "kyb_status",
                "booking_mode_default",
                "fare_collection_mode",
                "capacity_enforced",
            ]
        )

        route = Route.all_objects.filter(business=business, name=OPEN_SEATING_ROUTE_NAME).first()
        if route is None:
            route = create_route(
                business=business,
                name=OPEN_SEATING_ROUTE_NAME,
                code="OS-1",
                description="Seeded demo route for the open-seating booking flow.",
                created_by=actor,
            )

        stops: list[Stop] = []
        for name, (latitude, longitude) in zip(
            OPEN_SEATING_STOP_NAMES, OPEN_SEATING_STOP_COORDINATES, strict=True
        ):
            stop = Stop.all_objects.filter(business=business, name=name).first()
            if stop is None:
                stop = create_stop(
                    business=business,
                    name=name,
                    address=f"{name}, Lagos",
                    latitude=latitude,
                    longitude=longitude,
                    created_by=actor,
                )
            elif stop.latitude != latitude or stop.longitude != longitude:
                # Force-reset for the same self-healing reason the
                # Business fields above get one: a database seeded before
                # spec 20 slice 3 added coordinates here would otherwise
                # carry `latitude=None` forever, and this is the fixture
                # suite's only coordinated route.
                stop.latitude = latitude
                stop.longitude = longitude
                stop.save(update_fields=["latitude", "longitude"])
            stops.append(stop)
        set_route_stops(route=route, stops=stops, updated_by=actor)

        vehicle_type = VehicleType.all_objects.filter(
            business=business, name=OPEN_SEATING_VEHICLE_TYPE_NAME
        ).first()
        if vehicle_type is None:
            vehicle_type = create_vehicle_type(
                business=business,
                name=OPEN_SEATING_VEHICLE_TYPE_NAME,
                capacity=OPEN_SEATING_CAPACITY,
                created_by=actor,
            )

        vehicle = Vehicle.all_objects.filter(
            business=business, registration_number=OPEN_SEATING_REGISTRATION
        ).first()
        if vehicle is None:
            vehicle = create_vehicle(
                business=business,
                vehicle_type=vehicle_type,
                registration_number=OPEN_SEATING_REGISTRATION,
                insurance_expires_at=None,
                roadworthiness_expires_at=None,
                created_by=actor,
            )

        if not FareRule.all_objects.filter(business=business, route=route).exists():
            create_fare_rule(
                business=business, route=route, amount=OPEN_SEATING_FARE, created_by=actor
            )

        # See the identical note (and the contextvar workaround) in
        # `_seed_bookable_journey`: a Route this command re-creates after
        # a wipe starts `draft`, and the passenger-facing search this
        # fixture feeds only matches `active` routes.
        if route.status == Route.Status.DRAFT:
            client_token = set_current_client_id(str(business.client_id))
            try:
                set_route_status(route=route, new_status=Route.Status.ACTIVE, actor=actor)
            finally:
                reset_current_client_id(client_token)

        today = timezone.localdate()
        for offset in range(OPEN_SEATING_TRIP_DAYS):
            service_date = today + datetime.timedelta(days=offset)
            if Trip.all_objects.filter(route=route, service_date=service_date).exists():
                continue
            create_manual_trip(
                route=route,
                service_date=service_date,
                departure_time=OPEN_SEATING_DEPARTURE_TIME,
                vehicle=vehicle,
                driver=None,
                created_by=actor,
            )

        self._seed_boardable_open_seating_ticket(
            client=client, route=route, passenger=passenger, stops=stops
        )

    def _seed_boardable_open_seating_ticket(
        self, *, client: Client, route: Route, passenger: User, stops: list[Stop]
    ) -> None:
        """One paid open-seating Booking on today's trip, so
        validator-app's e2e has a real **seatless** Ticket to scan.

        It cannot come from the UI. Paying leaves the app for Paystack,
        which no browser test can complete, so the purchase half of
        docs/specs/10-booking-modes.md's e2e requirement is covered
        through the customer app and the scan half is seeded here — the
        same split `bookings.spec.ts` already uses for its own API half.

        `mark_booking_paid` is called directly, which means this Booking
        is `paid` with **no** `PaymentIntent` and no ledger entry behind
        it. That is deliberate and dev/CI-only: the point is a valid
        signed Ticket, not a faithful money trail.

        Reseeds only when the previous run's ticket has been boarded — a
        Ticket is single-use, so reusing one would make the second run
        of the spec 409. That does mean one Booking accumulates per run
        that boards it; the fixture vehicle is sized for it, and
        `prune_e2e_test_data` cannot remove them (a Ticket protects its
        Booking), which is worth knowing before wondering where they
        came from.
        """
        # Local imports: these pull apps.ticketing (and its crypto
        # dependencies) in through apps.booking.services, and only this
        # one fixture needs them.
        from apps.booking.services import create_booking, mark_booking_paid
        from apps.ticketing.models import Ticket

        # The next *future* departure, not simply today's. A Ticket's
        # `expires_at` is anchored to `scheduled_departure_at`, and the
        # `ticket_expires_after_issued` check constraint rejects one
        # that expired before it was issued — so seeding against today's
        # trip fails for the rest of the day once it has departed.
        trip = (
            Trip.all_objects.filter(route=route, scheduled_departure_at__gt=timezone.now())
            .order_by("scheduled_departure_at")
            .first()
        )
        if trip is None:
            return

        boardable = Ticket.all_objects.filter(
            trip=trip, booking__passenger=passenger, status=Ticket.Status.ISSUED
        ).exists()
        if boardable:
            return

        # `create_booking` reads through `.objects`, the tenant-scoped
        # manager, which is driven by the Python contextvar — and
        # `platform_staff_bypass()` deliberately never touches that, only
        # the Postgres GUCs. Without this the very first lookup raises
        # `Trip.DoesNotExist` for a Trip that plainly exists. Exactly the
        # trap CLAUDE.md documents for management commands; the rest of
        # this file avoids it only by using `all_objects` throughout.
        client_token = set_current_client_id(str(client.id))
        try:
            booking = create_booking(
                trip=trip,
                passenger=passenger,
                passenger_count=OPEN_SEATING_TICKET_PASSENGERS,
                from_stop=stops[0],
                to_stop=stops[-1],
                # A fresh key per seeding: this deliberately creates a
                # *new* booking each time the previous ticket has been
                # used up, so a stable key would return the original
                # booking and the spec would find only a boarded ticket.
                idempotency_key=f"e2e-open-seating-{timezone.now().isoformat()}",
            )
        finally:
            reset_current_client_id(client_token)
        mark_booking_paid(booking=booking)
