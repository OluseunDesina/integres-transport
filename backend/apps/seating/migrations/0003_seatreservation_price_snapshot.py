"""Add nullable price-snapshot columns onto SeatReservation.

Backfill and NOT NULL enforcement land in 0004 / 0005 — Postgres refuses
to create the new FK indexes in the same transaction as the UPDATEs that
populate them ("pending trigger events").
"""

from __future__ import annotations

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("seating", "0002_seed_expiry_sweep_periodic_task"),
        ("booking", "0002_booking_currency"),
        ("fares", "0002_version_fare_rules"),
    ]

    operations = [
        migrations.AddField(
            model_name="seatreservation",
            name="amount",
            field=models.DecimalField(decimal_places=2, max_digits=10, null=True),
        ),
        migrations.AddField(
            model_name="seatreservation",
            name="fare_rule",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.PROTECT,
                related_name="+",
                to="fares.farerule",
            ),
        ),
        migrations.AddField(
            model_name="seatreservation",
            name="fare_segment_rule",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.PROTECT,
                related_name="+",
                to="fares.faresegmentrule",
            ),
        ),
    ]
