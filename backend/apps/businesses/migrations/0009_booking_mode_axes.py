"""Adds the three new Business axes — docs/specs/10-booking-modes.md.

Fields only. Narrowing `booking_mode_default`'s choices to drop
`tap_and_go` is deliberately a *later* migration (0011), so the
0010 backfill in between still runs while the value it is migrating
away from is a coherent part of the enum.
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('businesses', '0008_director_kybdocument_director'),
    ]

    operations = [
        migrations.AddField(
            model_name='business',
            name='capacity_enforced',
            field=models.BooleanField(default=True),
        ),
        migrations.AddField(
            model_name='business',
            name='fare_collection_mode',
            field=models.CharField(choices=[('prepaid', 'Prepaid'), ('pay_as_you_go', 'Pay as you go')], default='prepaid', max_length=20),
        ),
        migrations.AddField(
            model_name='business',
            name='seat_selection_enabled',
            field=models.BooleanField(default=True),
        ),
    ]
