"""Snapshot Business.currency onto Booking at purchase time."""

from __future__ import annotations

from django.db import connection, migrations, models


def backfill_currency(apps, schema_editor):  # type: ignore[no-untyped-def]
    # Booking is RLS-protected — without the platform-staff GUC the UPDATE
    # matches zero rows and the subsequent NOT NULL alter fails.
    with connection.cursor() as cursor:
        cursor.execute("SELECT set_config('app.is_platform_staff', 'true', true)")
        cursor.execute("SELECT set_config('app.current_client_id', NULL, true)")
        cursor.execute(
            """
            UPDATE booking_booking AS booking
            SET currency = COALESCE(business.currency, 'NGN')
            FROM businesses_business AS business
            WHERE business.id = booking.business_id
              AND booking.currency IS NULL
            """
        )


class Migration(migrations.Migration):
    dependencies = [
        ("booking", "0001_initial"),
        ("businesses", "0003_business_fare_pricing_mode"),
    ]

    operations = [
        migrations.AddField(
            model_name="booking",
            name="currency",
            field=models.CharField(max_length=8, null=True),
        ),
        migrations.RunPython(backfill_currency, migrations.RunPython.noop),
        migrations.AlterField(
            model_name="booking",
            name="currency",
            field=models.CharField(max_length=8),
        ),
    ]
