"""Booking gains `passenger_count` and the open-seating journey —
docs/specs/10-booking-modes.md.

`from_stop`/`to_stop` are nullable because a reservation booking has no
single journey: its segment lives per `SeatReservation` and can
legitimately differ between seats on one booking. They are, in
practice, required for open seating — enforced in
`apps.booking.services.create_booking` rather than by a
`CheckConstraint`, since the booking mode lives on `Trip`, across an FK
a check constraint cannot reach.
"""

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("booking", "0005_alter_booking_status"),
        ("network", "0001_initial"),
    ]

    operations = [
        migrations.AddField(
            model_name="booking",
            name="passenger_count",
            field=models.PositiveIntegerField(default=1),
        ),
        migrations.AddField(
            model_name="booking",
            name="from_stop",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.PROTECT,
                related_name="+",
                to="network.stop",
            ),
        ),
        migrations.AddField(
            model_name="booking",
            name="to_stop",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.PROTECT,
                related_name="+",
                to="network.stop",
            ),
        ),
    ]
