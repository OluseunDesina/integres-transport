"""Backfills every role preset's permissions — the whole backlog, not
just spec 17's two new codenames.

## Why this is needed at all

A seed migration grants a codename to **nobody who already exists**.
Each phase creates its `Permission` row and edits
`DEFAULT_ROLE_PERMISSIONS`, which `apps.identity.services.create_default_roles`
applies only to roles it creates — so coverage tracks exactly when each
codename was added. Measured on the development database before spec 16
slice 2: `analytics.view` had reached **4 of 307** Owner roles,
`notifications.view` 168/307, `ledger.view` 177/307.

`0019` repaired `analytics.view` alone. This repairs the rest and the
two new ones together, which is the last time it should ever be needed:
any future codename ships its own grant migration alongside its seed.

## Why a frozen literal, not an import

`DEFAULT_ROLE_PERMISSIONS` lives in `apps.identity.services` and will
keep changing. Importing it here would silently change what *this*
migration does every time a later phase edits that dict — a migration is
a historical record of one moment, so the moment is written down. Owner
is the deliberate exception: it means "every seeded permission" by
definition, so it is resolved against whatever `Permission` rows exist
when this runs.

## Why this is safe

**Additive only — it never revokes.** And nothing can have customised a
Role in the first place: `apps.identity.staff_urls` exposes exactly one
role endpoint, `RoleListView`, which is a `ListAPIView`. No API path in
this system edits a Role's permissions, so there is no operator
intention to clobber.

## Two load-bearing details

`set_rls_session_vars(None, is_platform_staff=True)` and
`Role.all_objects` are both required. `Role` is a `BaseModel` carrying an
RLS policy that fails closed, and a migration has no
`app.current_client_id` — so without the bypass every `SELECT` here
returns zero rows and this migration reports `OK` having done nothing.
That is not hypothetical: `0019`'s first version shipped exactly that
way, leaving the grant at 4/307 while appearing to succeed.
"""

from django.db import migrations

from apps.core.rls import set_rls_session_vars

# Frozen snapshot of DEFAULT_ROLE_PERMISSIONS as of docs/specs/17-incidents.md
# slice 1. "Owner" is absent on purpose — it means every seeded codename.
MANAGER_CODENAMES = [
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
    "tapngo.record",
    "tapngo.view",
    "ledger.view",
    "payments.view",
    "wallet.view",
    "ticketing.validate",
    "notifications.view",
    "analytics.view",
    "incidents.view",
    "incidents.manage",
]

STAFF_CODENAMES = [
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
]

# Only these are removed on reverse — see `revoke` below.
NEW_CODENAMES = ["incidents.view", "incidents.manage"]


def backfill(apps, schema_editor):
    set_rls_session_vars(None, is_platform_staff=True)
    Permission = apps.get_model("identity", "Permission")
    Role = apps.get_model("identity", "Role")

    by_codename = {permission.codename: permission for permission in Permission.objects.all()}
    if not by_codename:
        # A database with no seeded permissions has nothing to grant and
        # must not fail the deploy over it.
        return

    targets = {
        "Owner": list(by_codename),
        "Manager": MANAGER_CODENAMES,
        "Staff": STAFF_CODENAMES,
    }

    for name, codenames in targets.items():
        wanted = [by_codename[code] for code in codenames if code in by_codename]
        for role in Role.all_objects.filter(name=name).prefetch_related("permissions"):
            held = {permission.codename for permission in role.permissions.all()}
            missing = [permission for permission in wanted if permission.codename not in held]
            if missing:
                role.permissions.add(*missing)


def revoke(apps, schema_editor):
    """Removes only the codenames this migration introduced.

    The older ones cannot be un-granted: this migration cannot know which
    roles legitimately held them before it ran, and guessing would
    revoke access that predates it. Reversing therefore restores the
    spec-17 state exactly and leaves the reconciliation in place — the
    same best-effort posture `0019` takes.
    """
    set_rls_session_vars(None, is_platform_staff=True)
    Permission = apps.get_model("identity", "Permission")
    Role = apps.get_model("identity", "Role")

    permissions = list(Permission.objects.filter(codename__in=NEW_CODENAMES))
    if not permissions:
        return
    for role in Role.all_objects.filter(permissions__codename__in=NEW_CODENAMES).distinct():
        role.permissions.remove(*permissions)


class Migration(migrations.Migration):

    dependencies = [
        ("identity", "0020_seed_spec17_incidents_permissions"),
    ]

    operations = [
        migrations.RunPython(backfill, revoke),
    ]
