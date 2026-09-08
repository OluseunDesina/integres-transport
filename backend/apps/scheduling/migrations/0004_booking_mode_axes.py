"""Adds Trip.fare_collection_mode — docs/specs/10-booking-modes.md.

Field only; see businesses/0009's docstring for why the matching
choices narrowing is held back to scheduling/0005.
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('scheduling', '0003_alter_schedule_managers_alter_trip_managers'),
        # Trip.fare_collection_mode's choices come from
        # Business.FareCollectionMode, added in that migration.
        ('businesses', '0009_booking_mode_axes'),
    ]

    operations = [
        migrations.AddField(
            model_name='trip',
            name='fare_collection_mode',
            field=models.CharField(choices=[('prepaid', 'Prepaid'), ('pay_as_you_go', 'Pay as you go')], default='prepaid', max_length=20),
        ),
    ]
