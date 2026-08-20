"""Seeds the Phase 9 permission codename (see
docs/specs/9-notifications.md). Append-only, same convention as every
prior phase's seed migration. Not actually used to gate any v1
endpoint (all three are IsAuthenticated + own-row-scoped) — seeded now
because a future staff-facing cross-recipient list would need it."""

from django.db import migrations

PERMISSIONS = [
    ("notifications.view", "View one's own notifications"),
]


def seed_permissions(apps, schema_editor):
    Permission = apps.get_model("identity", "Permission")
    for codename, description in PERMISSIONS:
        Permission.objects.get_or_create(codename=codename, defaults={"description": description})


def unseed_permissions(apps, schema_editor):
    Permission = apps.get_model("identity", "Permission")
    Permission.objects.filter(codename__in=[codename for codename, _ in PERMISSIONS]).delete()


class Migration(migrations.Migration):

    dependencies = [
        ('identity', '0016_seed_phase6_ticketing_permissions'),
    ]

    operations = [
        migrations.RunPython(seed_permissions, unseed_permissions),
    ]
