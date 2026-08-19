"""Seeds the Phase 1 permission codenames (see
docs/specs/1-identity-client-business.md §2). Append-only by convention —
future phases add their own codenames the same way, in their own data
migration, never editing this one.
"""

from django.db import migrations

PERMISSIONS = [
    ("client.view", "View own Client's details and KYC status"),
    ("business.manage", "Create and edit Businesses, manage KYB submissions"),
    ("kyb.submit", "Upload KYB documents for a Business"),
    ("staff.invite", "Invite new staff members"),
    ("staff.manage", "List and manage existing staff members"),
    ("whitelabel.manage", "Edit white-label branding configuration"),
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
        ('identity', '0002_role_permission'),
    ]

    operations = [
        migrations.RunPython(seed_permissions, unseed_permissions),
    ]
