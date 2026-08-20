"""Fat-service layer for Client registration and KYC review — thin views
call these, per CLAUDE.md's "fat services / thin views" convention. First
real callers of `apps.core.audit.record_audit_event`.
"""

import secrets
from datetime import timedelta
from typing import Any

from django.db import transaction
from django.shortcuts import get_object_or_404
from django.utils import timezone

from apps.core.audit import record_audit_event
from apps.core.rls import platform_staff_bypass
from apps.identity.models import User
from apps.identity.services import create_default_roles
from apps.notifications.services import notify_kyc_submitted

from .models import Client, ClientInvitation, KycDocument, WhiteLabelConfig
from .tasks import send_client_invitation_email

INVITATION_LIFETIME = timedelta(days=7)


def register_client(*, name: str, email: str, phone: str, password: str) -> User:
    """Creates the Client and its owner User in one transaction. KYC
    starts at its default `pending` status — no document uploaded yet.

    Slice 4: creates the 3 default Roles and assigns Owner to the
    registering user — the "additive, no rework" change promised in
    Slice 2's implementation note.
    """
    with transaction.atomic():
        client = Client.objects.create(name=name, email=email, phone=phone)
        roles = create_default_roles(client)
        owner = User.objects.create_user(
            email=email,
            password=password,
            client=client,
            is_client_staff=True,
            role=roles["Owner"],
        )
    # Client has no `client_id` attribute for record_audit_event to
    # auto-resolve (it *is* the tenant root, not a BaseModel subclass),
    # and there's no active tenancy context yet either (anonymous
    # request) — must pass it explicitly.
    record_audit_event(
        actor=owner, action="client.registered", target=client, client_id=str(client.id)
    )
    return owner


def submit_kyc_document(
    *, client: Client, document_type: str, file: object, uploaded_by: User
) -> KycDocument:
    """Any upload while `kyc_status` is `pending` or `rejected` moves it to
    `submitted` — including the very first upload, which is what makes a
    freshly-registered Client show up in the review queue at all (the
    spec's §6 only spells out the rejected→submitted case explicitly)."""
    document = KycDocument.objects.create(
        client=client, document_type=document_type, file=file
    )
    if client.kyc_status in (Client.KycStatus.PENDING, Client.KycStatus.REJECTED):
        client.kyc_status = Client.KycStatus.SUBMITTED
        client.kyc_submitted_at = timezone.now()
        client.save(update_fields=["kyc_status", "kyc_submitted_at"])
    record_audit_event(
        actor=uploaded_by,
        action="client.kyc_document_submitted",
        target=document,
        document_type=document_type,
    )
    notify_kyc_submitted(client_id=client.id, client_name=client.name, document_id=document.id)
    return document


def decide_client_kyc(*, client: Client, decision: str, reason: str, decided_by: User) -> Client:
    """`select_for_update()` per spec §7's concurrent-decision note — two
    platform staff deciding the same Client simultaneously must not
    produce an inconsistent kyc_status/kyc_decided_by pair."""
    with transaction.atomic():
        client = Client.objects.select_for_update().get(pk=client.pk)
        if decision == "approve":
            client.kyc_status = Client.KycStatus.APPROVED
            client.kyc_rejection_reason = ""
        else:
            client.kyc_status = Client.KycStatus.REJECTED
            client.kyc_rejection_reason = reason
        client.kyc_decided_at = timezone.now()
        client.kyc_decided_by = decided_by
        client.save(
            update_fields=[
                "kyc_status",
                "kyc_rejection_reason",
                "kyc_decided_at",
                "kyc_decided_by",
            ]
        )
    record_audit_event(
        actor=decided_by,
        action="client.kyc_decided",
        target=client,
        client_id=str(client.id),
        decision=decision,
        reason=reason,
    )
    return client


def client_email_taken(email: str) -> bool:
    """Shared by `ClientRegistrationSerializer.validate_email` and
    `ClientInvitationCompleteSerializer.validate` — the same email could
    be registered directly via `/clients/register/` in the window between
    a client-invitation being sent and completed, so completion must
    re-check this, not just trust the state at invite time."""
    return Client.objects.filter(email__iexact=email).exists()


def invite_client(*, name: str, email: str, invited_by: User) -> ClientInvitation:
    invitation = ClientInvitation.objects.create(
        name=name,
        email=email,
        invited_by=invited_by,
        token=secrets.token_urlsafe(32),
        expires_at=timezone.now() + INVITATION_LIFETIME,
    )
    # Same on-commit deferral as apps.identity.services.invite_staff, and
    # the same reasoning: this runs inside TenancyMiddleware's open
    # transaction, so an immediate .delay() risks the worker picking up
    # the task before the row is actually committed.
    transaction.on_commit(lambda: send_client_invitation_email.delay(str(invitation.id)))
    record_audit_event(actor=invited_by, action="client.invited", target=invitation, email=email)
    return invitation


def resolve_client_invitation(token: str) -> ClientInvitation:
    """No `platform_staff_bypass()` needed here, unlike
    `apps.identity.services.resolve_invitation` — `ClientInvitation`
    isn't a `BaseModel` subclass, so its default manager carries no
    tenancy scoping to begin with; an anonymous caller can read it
    directly. Lazily transitions `pending` -> `expired` against
    `expires_at`, same as the StaffInvitation equivalent (spec §7: not
    via a scheduled task)."""
    invitation = get_object_or_404(ClientInvitation, token=token)
    if (
        invitation.status == ClientInvitation.Status.PENDING
        and invitation.expires_at < timezone.now()
    ):
        invitation.status = ClientInvitation.Status.EXPIRED
        invitation.save(update_fields=["status"])
    return invitation


def complete_client_invitation(
    *, invitation: ClientInvitation, phone: str, password: str
) -> User:
    """Caller (the view, via `ClientInvitationCompleteSerializer.validate`)
    must have already confirmed `invitation.status == PENDING`. Reuses
    `register_client()` unchanged so self-registration and
    invitation-completion produce identical Client/User/Role state (spec
    §8) — this function only layers invitation bookkeeping on top,
    mirroring how `apps.identity.services.accept_staff_invitation` layers
    its own audit event on top of user creation."""
    owner = register_client(
        name=invitation.name, email=invitation.email, phone=phone, password=password
    )
    invitation.status = ClientInvitation.Status.ACCEPTED
    invitation.save(update_fields=["status"])
    record_audit_event(
        actor=owner,
        action="client.invitation_completed",
        target=invitation,
        client_id=str(owner.client_id),
    )
    return owner


def get_or_create_white_label(client: Client) -> WhiteLabelConfig:
    config, _ = WhiteLabelConfig.objects.get_or_create(client=client)
    return config


def update_white_label(*, client: Client, updated_by: User, **fields: Any) -> WhiteLabelConfig:
    config = get_or_create_white_label(client)
    for field, value in fields.items():
        setattr(config, field, value)
    config.save(update_fields=list(fields))
    record_audit_event(actor=updated_by, action="white_label.updated", target=config, **fields)
    return config


def resolve_white_label_by_domain(domain: str) -> WhiteLabelConfig | None:
    """Anonymous, cross-client by nature (a visitor's browser Host header
    could belong to any Client) — needs the platform-staff RLS bypass the
    same way `apps.identity.services.resolve_invitation` does. Returns
    `None` on no match rather than raising; the view turns that into a
    404 (§6: branding resolution isn't an access gate, just a lookup)."""
    with platform_staff_bypass():
        return (
            WhiteLabelConfig.all_objects.select_related("client")
            .filter(domain=domain)
            .first()
        )
