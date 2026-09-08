"""Seeds the spec 16 permission codename (see
docs/specs/16-operational-analytics.md). Append-only, same convention as
every prior phase's seed migration.

Granted to the Owner and Manager presets in `DEFAULT_ROLE_PERMISSIONS`,
and deliberately **not** to Staff: revenue totals are a different
sensitivity from the operational lists Staff needs. Export reuses the
permission of the resource being exported rather than adding an
`export.perform` — a caller who can read a list can read it as a file.
"""

from django.db import migrations

PERMISSIONS = [
    ("analytics.view", "View operational analytics and revenue reporting"),
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
        ('identity', '0017_seed_phase9_notifications_permission'),
    ]

    operations = [
        migrations.RunPython(seed_permissions, unseed_permissions),
    ]
