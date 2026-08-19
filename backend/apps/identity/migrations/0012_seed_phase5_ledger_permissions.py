"""Seeds the Phase 5 Slice 1 permission codename (see
docs/specs/5-payments-wallet-ledger.md). Append-only, same convention as
every prior phase's seed migration."""

from django.db import migrations

PERMISSIONS = [
    ("ledger.view", "View a Business's ledger accounts and journal entries"),
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
        ("identity", "0011_seed_phase4b_tapngo_permissions"),
    ]

    operations = [
        migrations.RunPython(seed_permissions, unseed_permissions),
    ]
