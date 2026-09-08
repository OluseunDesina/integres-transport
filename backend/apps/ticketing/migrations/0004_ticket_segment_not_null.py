"""Tightens the columns `0003` backfilled to non-null.

Every Ticket has a journey — that is true in both booking modes, and is
the whole reason these moved off `seat_reservation`. Leaving them
nullable would let a future write path create a ticket nobody can
validate the segment of, with nothing to catch it.
"""

import django.contrib.postgres.fields.ranges
import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("ticketing", "0003_backfill_ticket_segments"),
    ]

    operations = [
        migrations.AlterField(
            model_name="ticket",
            name="from_stop",
            field=models.ForeignKey(
                on_delete=django.db.models.deletion.PROTECT,
                related_name="+",
                to="network.stop",
            ),
        ),
        migrations.AlterField(
            model_name="ticket",
            name="to_stop",
            field=models.ForeignKey(
                on_delete=django.db.models.deletion.PROTECT,
                related_name="+",
                to="network.stop",
            ),
        ),
        migrations.AlterField(
            model_name="ticket",
            name="segment_range",
            field=django.contrib.postgres.fields.ranges.IntegerRangeField(),
        ),
    ]
