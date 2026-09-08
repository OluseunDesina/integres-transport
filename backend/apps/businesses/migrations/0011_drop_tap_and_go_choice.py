"""Drops `tap_and_go` from `Business.booking_mode_default`'s choices —
docs/specs/10-booking-modes.md.

State-only in practice: `choices` is a Python-level constraint, not a
database one, so this emits no DDL. It runs after 0010 purely so the
enum is never narrower than the data it describes at any point in the
migration history.
"""

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("businesses", "0010_backfill_booking_mode_axes"),
    ]

    operations = [
        migrations.AlterField(
            model_name="business",
            name="booking_mode_default",
            field=models.CharField(
                choices=[("reservation", "Reservation"), ("open_seating", "Open seating")],
                max_length=20,
            ),
        ),
    ]
