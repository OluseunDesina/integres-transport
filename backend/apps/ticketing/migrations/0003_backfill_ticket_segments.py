"""Backfills the columns `0002` added — docs/specs/10-booking-modes.md.

Every existing Ticket is a reservation ticket, so its journey is
readable from its `SeatReservation`, which already carries both stops
and the derived `segment_range`. `Booking.passenger_count` likewise
comes from its seat count.

**RLS and managers.** Same two traps slice 1's own backfill hit, and the
same fixes (see `apps/businesses/migrations/0010_backfill_booking_mode_axes.py`
for the full account):

- `set_rls_session_vars(None, is_platform_staff=True)` first, or every
  row is invisible and the backfill is a silent no-op that exits
  cleanly.
- Reads go through **`all_objects`**. In a migration the historical
  managers are plain and unscoped, but the live registry gives
  `TenantScopedManager`, which matches nothing outside a
  `tenant_context` — so using `objects` here makes the function
  untestable by direct call and lies about its intent, since this is
  deliberately a cross-client operation.
- Completeness is asserted by **counting leftovers in raw SQL**, which
  takes the ORM manager out of the loop. An ORM count read back through
  the same manager that did the write passes vacuously when rows are
  hidden.
"""

from django.db import migrations

from apps.core.rls import set_rls_session_vars


def _count_null(table, column):
    from django.db import connection

    with connection.cursor() as cursor:
        cursor.execute(f"SELECT COUNT(*) FROM {table} WHERE {column} IS NULL")  # noqa: S608
        return cursor.fetchone()[0]


def backfill(apps, schema_editor):
    set_rls_session_vars(None, is_platform_staff=True)
    Ticket = apps.get_model("ticketing", "Ticket")
    Booking = apps.get_model("booking", "Booking")
    SeatReservation = apps.get_model("seating", "SeatReservation")

    reservations = {
        reservation.id: reservation for reservation in SeatReservation.all_objects.all()
    }
    for ticket in Ticket.all_objects.all():
        reservation = reservations.get(ticket.seat_reservation_id)
        if reservation is None:
            # Cannot happen: seat_reservation was non-null until 0002
            # and open seating cannot have issued anything yet.
            continue
        ticket.from_stop_id = reservation.from_stop_id
        ticket.to_stop_id = reservation.to_stop_id
        ticket.segment_range = reservation.segment_range
        ticket.save(update_fields=["from_stop_id", "to_stop_id", "segment_range"])

    for booking in Booking.all_objects.all():
        seat_count = SeatReservation.all_objects.filter(booking_id=booking.id).count()
        # A booking with no reservations at all predates nothing in
        # particular — leave the field default of 1 rather than writing
        # a zero that would read as "nobody is travelling".
        booking.passenger_count = seat_count or 1
        booking.save(update_fields=["passenger_count"])

    for column in ("from_stop_id", "to_stop_id", "segment_range"):
        remaining = _count_null("ticketing_ticket", column)
        assert remaining == 0, (
            f"{remaining} tickets still have a null {column} after the backfill — "
            "the update matched fewer rows than exist, so something hid them."
        )


def unbackfill(apps, schema_editor):
    """A real reverse: `0004` widens these back to nullable before this
    runs, and clearing them restores the pre-`0002` state exactly. The
    data is not lost — every value here is derived from
    `SeatReservation`, which is untouched."""
    set_rls_session_vars(None, is_platform_staff=True)
    Ticket = apps.get_model("ticketing", "Ticket")
    Booking = apps.get_model("booking", "Booking")
    Ticket.all_objects.all().update(from_stop=None, to_stop=None, segment_range=None)
    Booking.all_objects.all().update(passenger_count=1)


class Migration(migrations.Migration):
    dependencies = [
        ("ticketing", "0002_seatless_tickets"),
        ("booking", "0006_open_seating_fields"),
    ]

    operations = [
        migrations.RunPython(backfill, unbackfill),
    ]
