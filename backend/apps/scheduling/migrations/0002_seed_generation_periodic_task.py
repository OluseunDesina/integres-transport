"""Registers the daily Trip-generation job with django_celery_beat's
DB-backed scheduler (see docs/specs/3-network-scheduling-fleet.md §4).
01:00 UTC daily — a single fixed time, not staggered per Business
timezone (confirmed with the user: this is a fast, DB-only batch job
with no external calls). DB-backed via django_celery_beat means the run
time is adjustable later via Django admin without a code deploy.
"""

from django.db import migrations

TASK_NAME = "apps.scheduling.tasks.generate_trips"


def seed_periodic_task(apps, schema_editor):
    CrontabSchedule = apps.get_model("django_celery_beat", "CrontabSchedule")
    PeriodicTask = apps.get_model("django_celery_beat", "PeriodicTask")
    schedule, _ = CrontabSchedule.objects.get_or_create(
        minute="0",
        hour="1",
        day_of_week="*",
        day_of_month="*",
        month_of_year="*",
        timezone="UTC",
    )
    PeriodicTask.objects.get_or_create(
        task=TASK_NAME,
        defaults={"name": "Generate Trips (daily)", "crontab": schedule, "enabled": True},
    )


def unseed_periodic_task(apps, schema_editor):
    PeriodicTask = apps.get_model("django_celery_beat", "PeriodicTask")
    PeriodicTask.objects.filter(task=TASK_NAME).delete()
    # CrontabSchedule row intentionally left in place on reverse — other
    # PeriodicTasks could plausibly reuse the same "01:00 UTC daily" cron
    # row, and CrontabSchedule has no unique task identity of its own to
    # safely scope a delete to.


class Migration(migrations.Migration):

    dependencies = [
        ("scheduling", "0001_initial"),
        ("django_celery_beat", "0019_alter_periodictasks_options"),
    ]

    operations = [
        migrations.RunPython(seed_periodic_task, unseed_periodic_task),
    ]
