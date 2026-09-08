"""Seeds the spec 17 permission codenames (see
docs/specs/17-incidents.md). Append-only, same convention as every prior
phase's seed migration.

Granted to **all three** presets in `DEFAULT_ROLE_PERMISSIONS` — Staff
included, unlike `analytics.view`. Frontline staff are exactly who
notices a broken reader, and gating incident reporting behind a manager
role would guarantee nothing gets reported.

Passenger submission needs no codename at all: it is authenticated
customer-audience access, like booking, and passengers have no Role
(docs/adr/0003).

`0021` is what actually reaches roles that already exist — a seed
migration alone grants a codename to nobody.
"""

from django.db import migrations

PERMISSIONS = [
    ("incidents.view", "View operational incidents and passenger issue reports"),
    ("incidents.manage", "Create, edit, assign and move incidents through their lifecycle"),
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
        ("identity", "0019_grant_analytics_view_to_existing_roles"),
    ]

    operations = [
        migrations.RunPython(seed_permissions, unseed_permissions),
    ]
