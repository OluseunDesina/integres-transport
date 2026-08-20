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

from apps.businesses.models import Business, KybDocument
from apps.businesses.services import create_business, submit_kyb_document
from apps.clients.models import Client, KycDocument
from apps.clients.services import submit_kyc_document
from apps.core.rls import platform_staff_bypass
from apps.fares.models import FareRule
from apps.fares.services import create_fare_rule
from apps.fleet.models import Vehicle, VehicleType
from apps.fleet.services import create_vehicle, create_vehicle_type
from apps.identity.models import User
from apps.identity.services import create_default_roles
from apps.network.models import Route, Stop
from apps.network.services import create_route, create_stop, set_route_stops
from apps.scheduling.models import Trip
from apps.scheduling.services import create_manual_trip
from apps.seating.models import Seat
from apps.seating.services import generate_seat_layout, replace_vehicle_type_seats
from apps.tapngo.models import TapCredential

E2E_PASSWORD = "e2e-test-password-123"  # noqa: S105

# Named so `prune_e2e_test_data` (which only ever touches rows under
# this one Client) imports the same literal rather than duplicating it —
# the two commands drifting apart on what "the e2e Client" means would
# be a real bug (an accidental prune of the wrong Client, or a stray
# fixture the pruner doesn't recognize as real).
E2E_CLIENT_NAME = "Integra E2E Test Client"
NETWORK_BUSINESS_NAME = "Integra E2E Network Test Business"
KYB_BUSINESS_NAME = "Integra E2E KYB Review Business"

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

# The tap-and-go fixture below, for validator-app's e2e coverage
# (docs/specs/4b-tap-and-go.md). A separate Business from the bookable
# fixture above — `booking_mode` is snapshotted per-Trip from
# `route.business.booking_mode_default`
# (`apps.scheduling.services.create_manual_trip`), not settable per-Trip,
# so a tap-and-go Trip needs its own Business with that default set.
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
            if not KybDocument.all_objects.filter(business=kyb_business).exists():
                submit_kyb_document(
                    business=kyb_business,
                    document_type=KybDocument.DocumentType.CERTIFICATE_OF_INCORPORATION,
                    file=ContentFile(b"e2e-test-certificate", name="certificate.pdf"),
                    uploaded_by=client_staff,
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

        self.stdout.write(self.style.SUCCESS("Seeded e2e test users."))

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

        today = timezone.localdate()
        for offset in range(BOOKABLE_TRIP_DAYS):
            service_date = today + datetime.timedelta(days=offset)
            if Trip.all_objects.filter(route=route, service_date=service_date).exists():
                continue
            create_manual_trip(
                route=route,
                service_date=service_date,
                departure_time=BOOKABLE_DEPARTURE_TIME,
                vehicle=vehicle,
                driver=None,
                created_by=actor,
            )

    def _seed_tap_and_go_fixture(self, *, client: Client, actor: User, passenger: User) -> None:
        """Everything validator-app's `record-tap` e2e spec needs: a
        tap-and-go-mode Business (a separate Business from the bookable
        fixture above, since `booking_mode` is snapshotted per-Trip from
        `route.business.booking_mode_default` at creation time — see
        `apps.scheduling.services.create_manual_trip`), a Route with
        Stops, a Vehicle, a flat fare, a week of Trips, and a
        `TapCredential` with a known, fixed raw token a Playwright spec
        can type into the form.

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
                booking_mode_default=Business.BookingMode.TAP_AND_GO,
                created_by=actor,
            )
        # Route creation is gated on an approved Business, same reason
        # `network_business` is force-reset above.
        business.kyb_status = Business.KybStatus.APPROVED
        business.save(update_fields=["kyb_status"])

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
