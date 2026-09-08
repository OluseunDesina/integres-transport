"""Adds `Booking.reference`, column only.

Split from `0009`, which backfills it and only then adds the unique
constraint. Doing both in one migration would add a unique index over a
column every existing row holds `""` in, and fail on the second booking
in any Business that has more than one.

See docs/specs/18-manifest-and-staff-booking.md slice 1 for why a
Booking needs a human reference at all: until this, the only identifier
either a passenger or a manifest could name was a UUID.
"""

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("booking", "0007_booking_booking_business_created_and_more"),
    ]

    operations = [
        migrations.AddField(
            model_name="booking",
            name="reference",
            field=models.CharField(blank=True, default="", max_length=16),
            preserve_default=False,
        ),
    ]
