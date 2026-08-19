"""Backfill SeatReservation.amount and fare-rule FKs under RLS bypass."""

from __future__ import annotations

from django.db import connection, migrations


def backfill_price_snapshot(apps, schema_editor):  # type: ignore[no-untyped-def]
    with connection.cursor() as cursor:
        cursor.execute("SELECT set_config('app.is_platform_staff', 'true', true)")
        cursor.execute("SELECT set_config('app.current_client_id', NULL, true)")
        cursor.execute(
            """
            UPDATE seating_seatreservation AS reservation
            SET amount = ROUND(
                booking.total_amount / GREATEST(seat_counts.n, 1),
                2
            )
            FROM booking_booking AS booking
            JOIN (
                SELECT booking_id, COUNT(*)::numeric AS n
                FROM seating_seatreservation
                GROUP BY booking_id
            ) AS seat_counts ON seat_counts.booking_id = booking.id
            WHERE booking.id = reservation.booking_id
              AND reservation.amount IS NULL
            """
        )
        cursor.execute(
            """
            UPDATE seating_seatreservation AS reservation
            SET fare_rule_id = rule.id
            FROM booking_booking AS booking,
                 scheduling_trip AS trip,
                 fares_farerule AS rule
            WHERE booking.id = reservation.booking_id
              AND trip.id = reservation.trip_id
              AND rule.route_id = trip.route_id
              AND rule.deleted_at IS NULL
              AND rule.effective_from <= booking.created_at
              AND (rule.effective_to IS NULL OR rule.effective_to > booking.created_at)
              AND reservation.fare_rule_id IS NULL
              AND reservation.fare_segment_rule_id IS NULL
            """
        )
        cursor.execute(
            """
            UPDATE seating_seatreservation AS reservation
            SET fare_segment_rule_id = rule.id
            FROM booking_booking AS booking,
                 scheduling_trip AS trip,
                 fares_faresegmentrule AS rule
            WHERE booking.id = reservation.booking_id
              AND trip.id = reservation.trip_id
              AND rule.route_id = trip.route_id
              AND rule.from_stop_id = reservation.from_stop_id
              AND rule.to_stop_id = reservation.to_stop_id
              AND rule.deleted_at IS NULL
              AND rule.effective_from <= booking.created_at
              AND (rule.effective_to IS NULL OR rule.effective_to > booking.created_at)
              AND reservation.fare_rule_id IS NULL
              AND reservation.fare_segment_rule_id IS NULL
            """
        )
        cursor.execute(
            """
            INSERT INTO fares_farerule (
                id, created_at, updated_at, deleted_at, amount,
                effective_from, effective_to, business_id, client_id, route_id
            )
            SELECT
                gen_random_uuid(),
                NOW(),
                NOW(),
                NULL,
                reservation.amount,
                booking.created_at,
                booking.created_at,
                booking.business_id,
                reservation.client_id,
                trip.route_id
            FROM seating_seatreservation AS reservation
            JOIN booking_booking AS booking ON booking.id = reservation.booking_id
            JOIN scheduling_trip AS trip ON trip.id = reservation.trip_id
            WHERE reservation.fare_rule_id IS NULL
              AND reservation.fare_segment_rule_id IS NULL
            """
        )
        cursor.execute(
            """
            UPDATE seating_seatreservation AS reservation
            SET fare_rule_id = rule.id
            FROM booking_booking AS booking,
                 scheduling_trip AS trip,
                 fares_farerule AS rule
            WHERE booking.id = reservation.booking_id
              AND trip.id = reservation.trip_id
              AND rule.route_id = trip.route_id
              AND rule.business_id = booking.business_id
              AND rule.effective_from = booking.created_at
              AND rule.effective_to = booking.created_at
              AND rule.amount = reservation.amount
              AND reservation.fare_rule_id IS NULL
              AND reservation.fare_segment_rule_id IS NULL
            """
        )


class Migration(migrations.Migration):
    dependencies = [
        ("seating", "0003_seatreservation_price_snapshot"),
    ]

    operations = [
        migrations.RunPython(backfill_price_snapshot, migrations.RunPython.noop),
    ]
