"""Migrates `tap_and_go` onto the two axes that replaced it —
docs/specs/10-booking-modes.md.

`tap_and_go` was never a booking mode. It meant three things at once:
you buy no seat, you are identified by a credential, and you pay after
travel. Only the first and third are modes, and they are independent:

    booking_mode_default = tap_and_go
        -> booking_mode_default = open_seating
           fare_collection_mode = pay_as_you_go

Everything else becomes `prepaid`, which is what it already was
implicitly.

**RLS.** `businesses_business` and `scheduling_trip` are both
RLS-protected with FORCE, and this migration's DB session never calls
`apps.core.rls.set_rls_session_vars`, so `app.current_client_id` and
`app.is_platform_staff` both read back NULL and every row is invisible.
The failure mode is not an error — it is a silent no-op that exits
cleanly, reporting success while migrating nothing. So the session vars
are set first, exactly as `ledger/0002` does, and for the same reason
that migration gives for calling `set_rls_session_vars` directly rather
than `platform_staff_bypass()`: there is no prior state to restore
inside a migration.

**Reads go through `all_objects`, not `objects`.** This is deliberately
a cross-client operation, so it uses the manager this codebase makes
grep-able for exactly that. It also makes the functions behave
identically whether they receive migration-historical models (where
both managers are plain and unscoped) or the real app registry (where
`objects` is `TenantScopedManager` and would silently match nothing
outside a `tenant_context`) — which is what makes the test in
`apps/businesses/tests/test_booking_mode_axes.py` able to call them
directly and mean something.

**The completeness check is raw SQL**, not an ORM count, and it checks
what *remains* rather than what was written. A `.update()` return value
only ever reports what the manager could see, so comparing it against a
count taken through that same manager is tautological: hide the rows
and both numbers are zero and the assertion passes while nothing
moved. Counting leftovers in SQL removes the manager from the loop.

To be exact about what that does and does not buy: raw SQL bypasses the
ORM's tenancy filtering, **not** RLS — a cursor in a session with no
`app.is_platform_staff` set sees nothing either. That is covered by the
`set_rls_session_vars` call at the top of each function, which is in
force for the rest of the transactional migration. The ORM manager was
the layer that actually bit here.
"""

from django.db import migrations

from apps.core.rls import set_rls_session_vars

TAP_AND_GO = "tap_and_go"
OPEN_SEATING = "open_seating"
RESERVATION = "reservation"
PREPAID = "prepaid"
PAY_AS_YOU_GO = "pay_as_you_go"


def _count_remaining(table, column):
    """Rows still holding `tap_and_go`, counted with raw SQL.

    Deliberately not an ORM count — see the module docstring.
    """
    from django.db import connection

    with connection.cursor() as cursor:
        cursor.execute(
            f"SELECT COUNT(*) FROM {table} WHERE {column} = %s",  # noqa: S608
            [TAP_AND_GO],
        )
        return cursor.fetchone()[0]


def split_tap_and_go(apps, schema_editor):
    set_rls_session_vars(None, is_platform_staff=True)
    Business = apps.get_model("businesses", "Business")
    Trip = apps.get_model("scheduling", "Trip")

    Business.all_objects.filter(booking_mode_default=TAP_AND_GO).update(
        booking_mode_default=OPEN_SEATING, fare_collection_mode=PAY_AS_YOU_GO
    )
    Trip.all_objects.filter(booking_mode=TAP_AND_GO).update(
        booking_mode=OPEN_SEATING, fare_collection_mode=PAY_AS_YOU_GO
    )

    # Everything not migrated above is prepaid. Redundant against the
    # field default for rows added by 0009, but not for anything a
    # concurrent writer inserted between the two migrations.
    Business.all_objects.exclude(booking_mode_default=OPEN_SEATING).update(
        fare_collection_mode=PREPAID
    )
    Trip.all_objects.exclude(booking_mode=OPEN_SEATING).update(fare_collection_mode=PREPAID)

    remaining_businesses = _count_remaining("businesses_business", "booking_mode_default")
    remaining_trips = _count_remaining("scheduling_trip", "booking_mode")
    assert remaining_businesses == 0, (
        f"{remaining_businesses} businesses still hold tap_and_go after the backfill — "
        "the update matched fewer rows than exist, so something hid them from this migration."
    )
    assert remaining_trips == 0, (
        f"{remaining_trips} trips still hold tap_and_go after the backfill — "
        "the update matched fewer rows than exist, so something hid them from this migration."
    )


def rejoin_tap_and_go(apps, schema_editor):
    """A real reverse, not a no-op.

    Only pay-as-you-go open seating was ever `tap_and_go`; open seating
    that is prepaid is new and has no pre-split equivalent, so it is
    left alone rather than being folded into a value it never held.
    """
    set_rls_session_vars(None, is_platform_staff=True)
    Business = apps.get_model("businesses", "Business")
    Trip = apps.get_model("scheduling", "Trip")

    Business.all_objects.filter(
        booking_mode_default=OPEN_SEATING, fare_collection_mode=PAY_AS_YOU_GO
    ).update(booking_mode_default=TAP_AND_GO)
    Trip.all_objects.filter(booking_mode=OPEN_SEATING, fare_collection_mode=PAY_AS_YOU_GO).update(
        booking_mode=TAP_AND_GO
    )


class Migration(migrations.Migration):
    dependencies = [
        ("businesses", "0009_booking_mode_axes"),
        # Trip.fare_collection_mode must exist before this writes to it.
        ("scheduling", "0004_booking_mode_axes"),
    ]

    operations = [
        migrations.RunPython(split_tap_and_go, rejoin_tap_and_go),
    ]
