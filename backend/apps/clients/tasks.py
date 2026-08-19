"""First Celery task in `apps.clients` — mirrors
`apps.identity.tasks.send_staff_invitation_email` structurally. Queued
via `transaction.on_commit()` in `apps.clients.services.invite_client`,
never called directly with `.delay()` — see that module for why.

No `platform_staff_bypass()` needed here: `ClientInvitation` isn't a
`BaseModel` subclass, so its default manager carries no tenancy scoping
to begin with.
"""

from celery import shared_task
from django.conf import settings
from django.core.mail import send_mail

from .models import ClientInvitation


@shared_task
def send_client_invitation_email(invitation_id: str) -> None:
    """§7: the invitation row is not rolled back if this fails — Celery's
    own retry/failure handling applies, the request that created the
    invitation has already returned successfully by the time this runs.
    """
    invitation = ClientInvitation.objects.get(pk=invitation_id)

    complete_url = f"{settings.CLIENT_ADMIN_APP_URL}/complete-invite?token={invitation.token}"
    send_mail(
        subject="You've been invited to Integra AFC",
        message=(
            f"Hi {invitation.name},\n\n"
            f"You've been invited to set up your organization on Integra.\n\n"
            f"Complete your registration: {complete_url}\n\n"
            f"This link expires on {invitation.expires_at:%Y-%m-%d}."
        ),
        from_email=None,
        recipient_list=[invitation.email],
    )
