"""Drops `tap_and_go` from `Trip.booking_mode`'s choices — the Trip-side
half of `businesses/0011`, whose docstring explains the ordering.
"""

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("scheduling", "0004_booking_mode_axes"),
        ("businesses", "0011_drop_tap_and_go_choice"),
    ]

    operations = [
        migrations.AlterField(
            model_name="trip",
            name="booking_mode",
            field=models.CharField(
                choices=[("reservation", "Reservation"), ("open_seating", "Open seating")],
                max_length=20,
            ),
        ),
    ]
