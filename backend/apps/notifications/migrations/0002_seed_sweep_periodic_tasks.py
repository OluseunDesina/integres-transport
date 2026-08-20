"""Registers both notification sweep jobs with django_celery_beat's
DB-backed scheduler (see docs/specs/9-notifications.md) — same shape
as apps.scheduling's 0002_seed_generation_periodic_task.py. Both run
daily: 03:00 UTC for the compliance sweep, 03:15 UTC for the ticket
reminder sweep (staggered 15 minutes apart, arbitrarily, so they never
contend for the same lock/connection burst)."""

from django.db import migrations

COMPLIANCE_TASK_NAME = "apps.notifications.tasks.notification_compliance_sweep"
TICKET_REMINDER_TASK_NAME = "apps.notifications.tasks.notification_ticket_reminder_sweep"


def seed_periodic_tasks(apps, schema_editor):
    CrontabSchedule = apps.get_model("django_celery_beat", "CrontabSchedule")
    PeriodicTask = apps.get_model("django_celery_beat", "PeriodicTask")

    compliance_schedule, _ = CrontabSchedule.objects.get_or_create(
        minute="0",
        hour="3",
        day_of_week="*",
        day_of_month="*",
        month_of_year="*",
        timezone="UTC",
    )
    PeriodicTask.objects.get_or_create(
        task=COMPLIANCE_TASK_NAME,
        defaults={
            "name": "Notification compliance sweep (daily)",
            "crontab": compliance_schedule,
            "enabled": True,
        },
    )

    ticket_reminder_schedule, _ = CrontabSchedule.objects.get_or_create(
        minute="15",
        hour="3",
        day_of_week="*",
        day_of_month="*",
        month_of_year="*",
        timezone="UTC",
    )
    PeriodicTask.objects.get_or_create(
        task=TICKET_REMINDER_TASK_NAME,
        defaults={
            "name": "Notification ticket-reminder sweep (daily)",
            "crontab": ticket_reminder_schedule,
            "enabled": True,
        },
    )


def unseed_periodic_tasks(apps, schema_editor):
    PeriodicTask = apps.get_model("django_celery_beat", "PeriodicTask")
    PeriodicTask.objects.filter(
        task__in=[COMPLIANCE_TASK_NAME, TICKET_REMINDER_TASK_NAME]
    ).delete()
    # CrontabSchedule rows intentionally left in place on reverse — same
    # reasoning as apps.scheduling's own migration: no unique task
    # identity to safely scope a delete to.


class Migration(migrations.Migration):

    dependencies = [
        ("notifications", "0001_initial"),
        ("django_celery_beat", "0019_alter_periodictasks_options"),
    ]

    operations = [
        migrations.RunPython(seed_periodic_tasks, unseed_periodic_tasks),
    ]
