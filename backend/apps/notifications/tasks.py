"""Celery Beat sweep jobs — see docs/specs/9-notifications.md. Same
shape as `apps.scheduling.tasks.generate_trips` /
`apps.seating.tasks.expire_seat_holds`: a plain `@shared_task` wrapper
around a directly-importable, directly-testable service function —
`apps.core.views` imports these same functions for the internal HTTP
endpoints that stand in for Celery Beat under the Vercel deployment
target (see docs/deployment.md §1.1)."""

from celery import shared_task

from .services import sweep_expiring_compliance, sweep_unused_tickets


@shared_task
def notification_compliance_sweep() -> None:
    sweep_expiring_compliance()


@shared_task
def notification_ticket_reminder_sweep() -> None:
    sweep_unused_tickets()
