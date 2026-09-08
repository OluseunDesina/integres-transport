"""Ticket becomes issuable without a seat — docs/specs/10-booking-modes.md.

`from_stop`/`to_stop`/`segment_range` are added **nullable here** and
tightened to non-null in `0004`, with the backfill in `0003` between.
Existing tickets have no value for them, so adding them non-null in one
step is not possible; the three-step add/backfill/tighten is the
standard safe shape and keeps each migration reversible on its own.
"""

import django.contrib.postgres.fields.ranges
import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("ticketing", "0001_initial"),
        ("network", "0001_initial"),
    ]

    operations = [
        migrations.AlterField(
            model_name="ticket",
            name="seat_reservation",
            field=models.OneToOneField(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.PROTECT,
                related_name="+",
                to="seating.seatreservation",
            ),
        ),
        migrations.AddField(
            model_name="ticket",
            name="passenger_index",
            field=models.PositiveIntegerField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="ticket",
            name="from_stop",
            field=models.ForeignKey(
                null=True,
                on_delete=django.db.models.deletion.PROTECT,
                related_name="+",
                to="network.stop",
            ),
        ),
        migrations.AddField(
            model_name="ticket",
            name="to_stop",
            field=models.ForeignKey(
                null=True,
                on_delete=django.db.models.deletion.PROTECT,
                related_name="+",
                to="network.stop",
            ),
        ),
        migrations.AddField(
            model_name="ticket",
            name="segment_range",
            field=django.contrib.postgres.fields.ranges.IntegerRangeField(null=True),
        ),
        migrations.AddConstraint(
            model_name="ticket",
            constraint=models.UniqueConstraint(
                condition=models.Q(("passenger_index__isnull", False)),
                fields=("booking", "passenger_index"),
                name="unique_passenger_index_per_booking",
            ),
        ),
    ]
