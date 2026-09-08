"""Grants `analytics.view` to Role rows that already existed when
slice 1 seeded it — see docs/specs/16-operational-analytics.md.

**Why this is needed at all.** Every prior phase's seed migration
creates the `Permission` row and adds the codename to
`DEFAULT_ROLE_PERMISSIONS`, which `apps.identity.services.create_default_roles`
applies — but only to roles it creates or is re-run over. A Client who
registered before the codename existed keeps a Role that never
references it. Measured on the dev database before this migration:
`analytics.view` reached **4 of 307** Owner roles, all four created
after slice 1 ran. Without this, spec 16's four endpoints would ship
403-ing for almost every existing Owner and Manager.

**Additive only, and safe.** It adds one codename and revokes nothing.
`create_default_roles` already calls `role.permissions.set(...)` on
every registration, and there is no endpoint anywhere that edits a
role's permissions (`apps/identity/staff_urls.py` exposes a list view
only) — so no Client can have deliberately removed this, and there is
nothing to clobber.

Owner and Manager only. Staff is excluded for the reason the preset
itself records: revenue totals are a different sensitivity from the
operational lists Staff needs.

**This is a per-codename repair, not the general fix.** The same gap
exists for every codename added since Phase 1 — on the same dev
database `ledger.view` reached 177/307 Owner roles and
`notifications.view` 168/307. Reconciling all of them is a real access
change across six other features and is deliberately left as its own
decision rather than smuggled in here.

**`set_rls_session_vars` and `all_objects` are both load-bearing.**
`Role` is a `BaseModel`, so it carries an RLS policy that fails closed:
a migration has no `app.current_client_id` set, so without the bypass
every `SELECT` here returns zero rows and this migration *succeeds
having done nothing*. That is not hypothetical — the first version of
this file did exactly that, reporting `OK` while leaving the grant at
4/307. Every prior seed migration escaped it only because `Permission`
is not a `BaseModel` and has no policy to fail closed.
"""

from django.db import migrations

from apps.core.rls import set_rls_session_vars

CODENAME = "analytics.view"
ROLE_NAMES = ["Owner", "Manager"]


def grant(apps, schema_editor):
    set_rls_session_vars(None, is_platform_staff=True)
    Permission = apps.get_model("identity", "Permission")
    Role = apps.get_model("identity", "Role")

    permission = Permission.objects.filter(codename=CODENAME).first()
    if permission is None:
        # 0018 seeds it; a database that somehow lacks it has nothing to
        # grant and must not fail the deploy over it.
        return

    for role in Role.all_objects.filter(name__in=ROLE_NAMES).exclude(
        permissions__codename=CODENAME
    ):
        role.permissions.add(permission)


def revoke(apps, schema_editor):
    """Reverses to the pre-migration state as closely as this can be
    known: it removes the codename from every Owner/Manager role. That
    is wider than the forward operation for roles created *after* 0018
    (which had it legitimately), which is why the forward direction is
    the supported one — a rollback here means rolling back spec 16
    entirely, at which point no role should reference it.
    """
    set_rls_session_vars(None, is_platform_staff=True)
    Permission = apps.get_model("identity", "Permission")
    Role = apps.get_model("identity", "Role")

    permission = Permission.objects.filter(codename=CODENAME).first()
    if permission is None:
        return
    for role in Role.all_objects.filter(name__in=ROLE_NAMES, permissions__codename=CODENAME):
        role.permissions.remove(permission)


class Migration(migrations.Migration):

    dependencies = [
        ("identity", "0018_seed_spec16_analytics_permission"),
    ]

    operations = [
        migrations.RunPython(grant, revoke),
    ]
