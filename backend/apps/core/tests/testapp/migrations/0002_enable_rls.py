from django.db import migrations

from apps.core.migration_operations import EnableRowLevelSecurity


class Migration(migrations.Migration):

    dependencies = [
        ("core_testapp", "0001_initial"),
    ]

    operations = [
        EnableRowLevelSecurity("TenancyProbe"),
    ]
