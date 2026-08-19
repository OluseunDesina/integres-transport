"""Enforce NOT NULL amount and the exactly-one fare-rule CHECK."""

from __future__ import annotations

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("seating", "0004_backfill_seatreservation_price_snapshot"),
    ]

    operations = [
        migrations.AlterField(
            model_name="seatreservation",
            name="amount",
            field=models.DecimalField(decimal_places=2, max_digits=10),
        ),
        migrations.AddConstraint(
            model_name="seatreservation",
            constraint=models.CheckConstraint(
                condition=(
                    models.Q(fare_rule__isnull=False, fare_segment_rule__isnull=True)
                    | models.Q(fare_rule__isnull=True, fare_segment_rule__isnull=False)
                ),
                name="seat_reservation_exactly_one_fare_rule",
            ),
        ),
    ]
