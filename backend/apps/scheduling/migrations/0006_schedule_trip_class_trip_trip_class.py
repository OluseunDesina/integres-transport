"""What a service is sold as — docs/specs/15-trip-classes.md.

Trip.trip_class is snapshotted from its Schedule at generation time, the
same way booking_mode and fare_collection_mode already are. Existing
rows of both models land on `standard`.
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('scheduling', '0005_drop_tap_and_go_choice'),
    ]

    operations = [
        migrations.AddField(
            model_name='schedule',
            name='trip_class',
            field=models.CharField(choices=[('premium', 'Premium'), ('exclusive', 'Exclusive'), ('standard', 'Standard'), ('mini', 'Mini')], default='standard', max_length=20),
        ),
        migrations.AddField(
            model_name='trip',
            name='trip_class',
            field=models.CharField(choices=[('premium', 'Premium'), ('exclusive', 'Exclusive'), ('standard', 'Standard'), ('mini', 'Mini')], default='standard', max_length=20),
        ),
    ]
