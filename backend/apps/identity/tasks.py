"""First real Celery task in this repo — Phase 0 wired the async infra
(config/celery.py) without anything to run yet.

Queued via `transaction.on_commit()` in `apps.identity.services.invite_staff`,
never called directly with `.delay()` — see that module for why.
"""

from celery import shared_task
from django.conf import settings
from django.core.mail import send_mail

from apps.core.rls import platform_staff_bypass

from .models import StaffInvitation


@shared_task
def send_staff_invitation_email(invitation_id: str) -> None:
    """§7: the invitation row is not rolled back if this fails — Celery's
    own retry/failure handling applies, the request that created the
    invitation has already returned successfully by the time this runs.
    """
    with platform_staff_bypass():
        invitation = StaffInvitation.all_objects.select_related("client", "role").get(
            pk=invitation_id
        )

    accept_url = f"{settings.CLIENT_ADMIN_APP_URL}/accept-invite?token={invitation.token}"
    send_mail(
        subject=f"You've been invited to join {invitation.client.name} on Integra",
        message=(
            f"You've been invited to join {invitation.client.name} as "
            f"{invitation.role.name}.\n\n"
            f"Accept your invitation: {accept_url}\n\n"
            f"This link expires on {invitation.expires_at:%Y-%m-%d}."
        ),
        from_email=None,
        recipient_list=[invitation.email],
    )
