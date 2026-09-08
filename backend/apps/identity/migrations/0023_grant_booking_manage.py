"""Grants `booking.manage` to the Owner and Manager roles that already
exist — docs/specs/18-manifest-and-staff-booking.md slice 2.

`0021`'s closing promise, kept: *"any future codename ships its own
grant migration alongside its seed."* Without this, `0022` creates a
`Permission` row that reaches nobody, and the counter-booking screen
403s for every Client registered before today.

Narrower than `0021` in two ways, both deliberate:

- **One codename, two presets.** Staff is excluded on purpose (see
  `0022`), so this must not use `0021`'s frozen preset lists — it grants
  exactly `booking.manage`, exactly to Owner and Manager.
- **Reversible in full.** `0021` could not un-grant the older codenames
  because it could not know which roles legitimately held them first.
  This one introduces its codename, so reversing it removes the grant
  cleanly.

The two load-bearing details from `0021` apply unchanged:
`set_rls_session_vars(None, is_platform_staff=True)` and
`Role.all_objects`. `Role` is a `BaseModel` whose RLS policy fails
closed, and a migration has no `app.current_client_id` — without the
bypass every SELECT here returns zero rows and this migration reports
`OK` having done nothing, which is exactly how `0019` first shipped.
"""

from django.db import migrations

from apps.core.rls import set_rls_session_vars

CODENAME = "booking.manage"
ROLE_NAMES = ["Owner", "Manager"]


def grant(apps, schema_editor):
    set_rls_session_vars(None, is_platform_staff=True)
    Permission = apps.get_model("identity", "Permission")
    Role = apps.get_model("identity", "Role")

    permission = Permission.objects.filter(codename=CODENAME).first()
    if permission is None:
        # A database with no seeded permissions has nothing to grant and
        # must not fail the deploy over it.
        return

    for role in Role.all_objects.filter(name__in=ROLE_NAMES).prefetch_related("permissions"):
        if not role.permissions.filter(codename=CODENAME).exists():
            role.permissions.add(permission)


def revoke(apps, schema_editor):
    set_rls_session_vars(None, is_platform_staff=True)
    Permission = apps.get_model("identity", "Permission")
    Role = apps.get_model("identity", "Role")

    permission = Permission.objects.filter(codename=CODENAME).first()
    if permission is None:
        return
    for role in Role.all_objects.filter(permissions__codename=CODENAME).distinct():
        role.permissions.remove(permission)


class Migration(migrations.Migration):

    dependencies = [
        ("identity", "0022_seed_spec18_booking_manage"),
    ]

    operations = [
        migrations.RunPython(grant, revoke),
    ]
