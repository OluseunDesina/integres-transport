"""Deletes stray e2e-test data that has accumulated under
`seed_e2e_users`'s fixtures from repeated Playwright runs over time.

Test infrastructure, not a production-safe operation — same posture as
`seed_e2e_users` (dev/CI use only), except this command is destructive
where that one is purely additive. Kept as a separate command rather
than folded into `seed_e2e_users` itself specifically so that command's
own "idempotent, never deletes" guarantee stays true.

Two known cruft sources, both confirmed by reading the specs that
create them: `frontend/e2e/client-admin-app/businesses.spec.ts`'s
`uniqueBusinessName()` creates a new `Business` under the e2e Client on
every run of its own tests and never cleans up, and
`frontend/e2e/client-admin-app/profile-menu.spec.ts`'s
`uniqueRouteName()` does the same for `Route` under the bookable
fixture Business. Only ever touches the one hardcoded e2e Client this
whole tool is scoped to — never parametrized to prune another Client.

Best-effort: a row with a protected dependent (a Vehicle/Trip/Booking/
etc. some other spec created against it) is skipped and counted rather
than force-cascaded. **The one deliberate exception** is a stray
Business's own `KybDocument`/`Director` rows (self-check
2026-09-12-specs19-21's F8): any e2e run that went through the KYB
submission flow leaves its throwaway Business with a `KybDocument`
attached, and that FK is `on_delete=PROTECT` — meaning almost every
stray Business this command finds was permanently unpruneable, and the
super-admin KYB queue could only ever grow. A dev/CI-only fixture
document carries no real audit or compliance value, unlike the same
model in production, so this command explicitly deletes a stray
Business's own documents (and any Director those documents alone
reference) before deleting the Business itself. `Route`'s own
`ProtectedError`s are deliberately NOT given the same treatment — those
come from real `Schedule`/`Trip`/`FareRule`/`Incident` rows, which are
usage data even in a test fixture, and force-cascading through them
risks leaving booking/ledger-adjacent rows in a broken state other
specs depend on.
"""

from typing import Any

from django.core.management.base import BaseCommand
from django.db.models import ProtectedError

from apps.businesses.models import Business, Director, KybDocument
from apps.clients.models import Client
from apps.core.management.commands.seed_e2e_users import (
    BOOKABLE_ROUTE_NAME,
    E2E_CLIENT_NAME,
    KYB_BUSINESS_NAME,
    NETWORK_BUSINESS_NAME,
    TAP_AND_GO_BUSINESS_NAME,
    TAP_AND_GO_ROUTE_NAME,
)
from apps.core.rls import platform_staff_bypass
from apps.network.models import Route

# Every Business seed_e2e_users itself manages, and — for each — the
# Route name(s) it seeds under that Business. Anything else found under
# this Client/these Businesses came from some other spec's own ad hoc
# fixture creation and is fair game to prune.
KNOWN_BUSINESS_NAMES = {KYB_BUSINESS_NAME, NETWORK_BUSINESS_NAME, TAP_AND_GO_BUSINESS_NAME}
KNOWN_ROUTE_NAMES_BY_BUSINESS = {
    NETWORK_BUSINESS_NAME: {BOOKABLE_ROUTE_NAME},
    TAP_AND_GO_BUSINESS_NAME: {TAP_AND_GO_ROUTE_NAME},
    KYB_BUSINESS_NAME: set(),
}


class Command(BaseCommand):
    help = (
        "Delete stray Businesses/Routes that have accumulated under the "
        "seed_e2e_users fixtures from repeated Playwright runs. Dev/CI only."
    )

    def add_arguments(self, parser: Any) -> None:
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Report what would be deleted without deleting anything.",
        )

    def handle(self, *args: Any, **options: Any) -> None:
        dry_run = options["dry_run"]
        client = Client.objects.filter(name=E2E_CLIENT_NAME).first()
        if client is None:
            self.stdout.write(f"No '{E2E_CLIENT_NAME}' Client found — nothing to prune.")
            return

        businesses_deleted = businesses_skipped = 0
        routes_deleted = routes_skipped = 0

        with platform_staff_bypass():
            stray_businesses = Business.all_objects.filter(client=client).exclude(
                name__in=KNOWN_BUSINESS_NAMES
            )
            for business in stray_businesses:
                if dry_run:
                    doc_count = KybDocument.all_objects.filter(business=business).count()
                    suffix = (
                        f" ({doc_count} KybDocument row(s) would go with it)" if doc_count else ""
                    )
                    self.stdout.write(f"[dry-run] would delete Business: {business.name}{suffix}")
                    continue
                try:
                    # Documents first, then any Director those documents
                    # alone protect, then the Business — the exact order
                    # `on_delete=PROTECT` requires. Nothing else in this
                    # codebase references a `KybDocument`, so deleting it
                    # is always safe; a `Director` is only unsafe to
                    # delete while a `KybDocument` still names it.
                    KybDocument.all_objects.filter(business=business).delete()
                    Director.all_objects.filter(business=business).delete()
                    business.delete()
                    businesses_deleted += 1
                except ProtectedError:
                    businesses_skipped += 1
                    self.stdout.write(
                        self.style.WARNING(f"Skipped Business (protected): {business.name}")
                    )

            for business_name, known_route_names in KNOWN_ROUTE_NAMES_BY_BUSINESS.items():
                fixture_business = Business.all_objects.filter(
                    client=client, name=business_name
                ).first()
                if fixture_business is None:
                    continue
                stray_routes = Route.all_objects.filter(business=fixture_business).exclude(
                    name__in=known_route_names
                )
                for route in stray_routes:
                    if dry_run:
                        self.stdout.write(
                            f"[dry-run] would delete Route: {route.name} ({business_name})"
                        )
                        continue
                    try:
                        route.delete()
                        routes_deleted += 1
                    except ProtectedError:
                        routes_skipped += 1
                        self.stdout.write(
                            self.style.WARNING(
                                f"Skipped Route (protected): {route.name} ({business_name})"
                            )
                        )

        if dry_run:
            self.stdout.write(self.style.SUCCESS("Dry run complete — nothing deleted."))
            return

        self.stdout.write(
            self.style.SUCCESS(
                f"{businesses_deleted} Businesses deleted, {businesses_skipped} skipped "
                f"(protected); {routes_deleted} Routes deleted, {routes_skipped} skipped "
                "(protected)."
            )
        )
