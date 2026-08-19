"""Registers the seat-hold expiry sweep with django_celery_beat's
DB-backed scheduler (see docs/specs/4-fares-seating-booking.md §4).
Every 1 minute, not staggered per Business — a fast, DB-only sweep with
no external calls, same reasoning apps/scheduling's own periodic-task
migration already used for its own fixed-time job.
"""

from django.db import migrations

TASK_NAME = "apps.seating.tasks.expire_seat_holds"


def seed_periodic_task(apps, schema_editor):
    IntervalSchedule = apps.get_model("django_celery_beat", "IntervalSchedule")
    PeriodicTask = apps.get_model("django_celery_beat", "PeriodicTask")
    schedule, _ = IntervalSchedule.objects.get_or_create(every=1, period="minutes")
    PeriodicTask.objects.get_or_create(
        task=TASK_NAME,
        defaults={
            "name": "Expire seat holds (every minute)",
            "interval": schedule,
            "enabled": True,
        },
    )


def unseed_periodic_task(apps, schema_editor):
    PeriodicTask = apps.get_model("django_celery_beat", "PeriodicTask")
    PeriodicTask.objects.filter(task=TASK_NAME).delete()
    # IntervalSchedule row intentionally left in place on reverse — same
    # "another PeriodicTask could plausibly reuse this cron/interval row"
    # reasoning apps/scheduling's own periodic-task migration documents.


class Migration(migrations.Migration):
    dependencies = [
        ("seating", "0001_initial"),
        ("django_celery_beat", "0019_alter_periodictasks_options"),
    ]

    operations = [
        migrations.RunPython(seed_periodic_task, unseed_periodic_task),
    ]
