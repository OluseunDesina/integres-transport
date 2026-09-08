"""Fat-service layer for Role/Permission/StaffInvitation — mirrors
apps.clients.services's shape (docs/specs/1-identity-client-business.md
§10 step 4: "mirrors step 2's shape" was Slice 3's phrase, but the same
discipline applies here).

Uniqueness/state validation (duplicate staff email, invitation no longer
pending) lives in the serializers, not here, matching the convention
`apps.clients.serializers.ClientRegistrationSerializer` already set —
these functions trust their inputs were already validated.
"""

import secrets
from datetime import timedelta
from typing import Any

from django.db import transaction
from django.shortcuts import get_object_or_404
from django.utils import timezone

from apps.clients.models import Client
from apps.core.audit import record_audit_event
from apps.core.rls import platform_staff_bypass

from .models import Permission, Role, StaffInvitation, User
from .tasks import send_staff_invitation_email

INVITATION_LIFETIME = timedelta(days=7)

# None means "every seeded permission" — resolved dynamically so Owner
# never drifts out of sync as future phases append codenames.
DEFAULT_ROLE_PERMISSIONS: dict[str, list[str] | None] = {
    "Owner": None,
    "Manager": [
        "client.view",
        "business.manage",
        "kyb.submit",
        "network.view",
        "network.manage",
        "fleet.view",
        "fleet.manage",
        "scheduling.view",
        "scheduling.manage",
        "fares.view",
        "fares.manage",
        "seating.view",
        "seating.manage",
        "booking.view",
        # docs/specs/18-manifest-and-staff-booking.md slice 2 — Owner
        # (None above) and Manager only. Booking on a passenger's behalf
        # creates a financial obligation for someone else, which is a
        # different authority from reading a manifest; Staff hold
        # `booking.view` and stop there.
        "booking.manage",
        "tapngo.record",
        "tapngo.view",
        "ledger.view",
        "payments.view",
        "wallet.view",
        "ticketing.validate",
        "notifications.view",
        # docs/specs/16-operational-analytics.md. Owner (None above =
        # every codename) and Manager only — Staff is deliberately
        # excluded, since revenue totals are a different sensitivity
        # from the operational lists Staff needs.
        "analytics.view",
        # docs/specs/17-incidents.md — granted to all three presets,
        # Staff included and unlike `analytics.view`. Frontline staff
        # are exactly who notices a broken reader; gating reporting
        # behind a manager role would guarantee nothing gets reported.
        "incidents.view",
        "incidents.manage",
    ],
    "Staff": [
        "client.view",
        "network.view",
        "fleet.view",
        "scheduling.view",
        "fares.view",
        "seating.view",
        "booking.view",
        "tapngo.record",
        "tapngo.view",
        "ledger.view",
        "payments.view",
        "wallet.view",
        "ticketing.validate",
        "notifications.view",
        "incidents.view",
        "incidents.manage",
    ],
}


def create_default_roles(client: Client) -> dict[str, Role]:
    """Idempotent — safe to call more than once for the same Client
    (registration calls it once; `ClientStaffUserFactory`'s test fixture
    calls it on demand and relies on the idempotency). Runs under the
    platform-staff RLS bypass since callers often have no tenancy context
    yet (an anonymous registration request) — uses `all_objects`
    throughout since the Python contextvar isn't touched by the bypass.
    """
    with platform_staff_bypass():
        all_codenames = list(Permission.objects.values_list("codename", flat=True))
        roles: dict[str, Role] = {}
        for name, codenames in DEFAULT_ROLE_PERMISSIONS.items():
            role, _ = Role.all_objects.get_or_create(
                client=client, name=name, defaults={"is_default_owner_role": name == "Owner"}
            )
            selected = all_codenames if codenames is None else codenames
            role.permissions.set(Permission.objects.filter(codename__in=selected))
            roles[name] = role
    return roles


def invite_staff(*, client: Client, email: str, role: Role, invited_by: User) -> StaffInvitation:
    invitation = StaffInvitation.objects.create(
        client=client,
        email=email,
        role=role,
        invited_by=invited_by,
        token=secrets.token_urlsafe(32),
        expires_at=timezone.now() + INVITATION_LIFETIME,
    )
    # Queued on commit, not immediately: invite_staff() runs inside
    # TenancyMiddleware's open transaction, so an immediate .delay()
    # risks a worker picking up the task before the invitation row is
    # actually committed. CELERY_TASK_ALWAYS_EAGER=True in CI makes this
    # run synchronously in-process — still correctly deferred to after
    # commit via django_capture_on_commit_callbacks in tests.
    transaction.on_commit(lambda: send_staff_invitation_email.delay(str(invitation.id)))
    record_audit_event(actor=invited_by, action="staff.invited", target=invitation, email=email)
    return invitation


def resolve_invitation(token: str) -> StaffInvitation:
    """Shared by the GET-resolve and POST-accept endpoints, both
    `AllowAny` — an anonymous caller has no tenancy context at all, so
    this runs under the platform-staff RLS bypass, exactly like an
    invitation link is meant to work (the token is the authorization).
    `select_related` so `invitation.client`/`invitation.role` are safe to
    read *after* this function returns, outside the bypass — a lazy FK
    traversal at that point would otherwise hit RLS again as anonymous.

    Lazily transitions `pending` → `expired` against `expires_at` here
    (§7: not via a scheduled task) — the one state mutation this
    read-oriented function does, mirroring how `submit_kyc_document`
    folds a status transition into what looks like a read-adjacent call.
    """
    with platform_staff_bypass():
        invitation = get_object_or_404(
            StaffInvitation.all_objects.select_related("client", "role"), token=token
        )
        if (
            invitation.status == StaffInvitation.Status.PENDING
            and invitation.expires_at < timezone.now()
        ):
            invitation.status = StaffInvitation.Status.EXPIRED
            invitation.save(update_fields=["status"])
    return invitation


def accept_staff_invitation(*, invitation: StaffInvitation, password: str) -> User:
    """Caller (the view) must have already validated `invitation.status
    == PENDING` — see `StaffInvitationAcceptSerializer.validate()`."""
    with platform_staff_bypass(), transaction.atomic():
        user = User.objects.create_user(
            email=invitation.email,
            password=password,
            client=invitation.client,
            is_client_staff=True,
            role=invitation.role,
        )
        invitation.status = StaffInvitation.Status.ACCEPTED
        invitation.save(update_fields=["status"])
    record_audit_event(
        actor=user,
        action="staff.invitation_accepted",
        target=invitation,
        client_id=str(invitation.client_id),
    )
    return user


def update_staff_member(*, user: User, updated_by: User, **fields: Any) -> User:
    metadata = {k: (str(v.pk) if hasattr(v, "pk") else v) for k, v in fields.items()}
    for field, value in fields.items():
        setattr(user, field, value)
    user.save(update_fields=list(fields))
    record_audit_event(actor=updated_by, action="staff.updated", target=user, **metadata)
    return user


class PassengerNotFound(Exception):
    """Raised for both "no such passenger" and "a passenger of another
    Client" — deliberately one exception, so the view cannot accidentally
    render two distinguishable responses (docs/adr/0002's account-
    existence rule, and this spec's own edge-case table)."""


def mask_email(email: str) -> str:
    """`ada.obi@example.com` → `a••••••@example.com`.

    Enough to confirm "yes, that is the address you typed" and not
    enough to be a directory. The counter agent typed the address to get
    here, so nothing is being withheld from them that they did not
    already have — what masking protects is the *screen*, which a queue
    of other passengers can see.
    """
    local, _, domain = email.partition("@")
    if not domain:
        return "•" * len(email)
    return f"{local[:1]}{'•' * max(len(local) - 1, 1)}@{domain}"


def lookup_passenger(*, email: str, client: Client) -> User:
    """Resolve one passenger of `client` by exact (case-insensitive)
    email — docs/specs/18-manifest-and-staff-booking.md slice 2.

    **Deliberately not a search.** A fuzzy passenger search over a
    Client's whole user base, in the hands of counter staff, is a
    data-protection problem; this answers "is the person standing here,
    who told me their address, already registered?" and nothing else.

    `client=` is not optional and not inferred: `identity.User` is the
    one model in this system that is **not** tenant-scoped (ADR-0003),
    so `objects` applies no RLS policy here and an unfiltered
    `User.objects.get(email=...)` would resolve another Client's
    passenger. The same email genuinely can exist under two Clients —
    that is a requirement of the brief, not an edge case
    (`apps.identity.serializers`' module docstring).

    `is_client_staff=False` keeps the endpoint from doubling as a staff
    directory, and `is_active=True` keeps a deactivated account from
    being booked for.
    """
    passenger = User.objects.filter(
        client=client,
        is_client_staff=False,
        is_active=True,
        email__iexact=email.strip(),
    ).first()
    if passenger is None:
        raise PassengerNotFound("No passenger account matches that email address.")
    return passenger
