"""Backfills `Booking.reference` for every existing row, then makes it
unique per Business.

## Why the backfill and the constraint are in the same migration

They must not be split any further. Between the backfill and the
constraint there is a window in which the column is populated but
unenforced; putting them in one migration makes that window the length
of one transaction rather than the length of a deploy. Splitting the
*column* out into `0008` is different — that one is safe to have run for
a while, because nothing reads the column yet.

## Two load-bearing details, the same two `identity/0021` documents

`set_rls_session_vars(None, is_platform_staff=True)` and
`Booking.all_objects`. `Booking` is a `BaseModel` carrying an RLS policy
that **fails closed**, and a migration has no `app.current_client_id` —
so without the bypass every `SELECT` here returns zero rows and this
migration reports `OK` having backfilled nothing, leaving the constraint
to be added over a column of empty strings. `identity/0019` shipped
exactly that failure once already.

`all_objects` rather than `objects` for the second reason: soft-deleted
bookings still occupy `(business, reference)` in the unique index, so
they must be given references too or the constraint fails on them.

## Uniqueness without a round trip per row

References are drawn per Business against a set of what that Business
has already been given, so a collision is resolved in memory rather than
by an `IntegrityError` and a retry. The alphabet is 32^6 ≈ 1.07e9, so
for any realistic per-Business booking count the loop below almost never
runs twice; the bound exists so a pathological database cannot hang a
deploy.
"""

import secrets

from django.db import migrations, models

from apps.core.rls import set_rls_session_vars

# Frozen copies of `apps.booking.services`'s constants. A migration is a
# historical record of one moment: importing them would silently change
# what this migration does the day someone lengthens the reference.
_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
_LENGTH = 6
_PREFIX = "BKG-"
_ATTEMPTS = 100
_BATCH = 500


def _candidate() -> str:
    return _PREFIX + "".join(secrets.choice(_ALPHABET) for _ in range(_LENGTH))


def backfill(apps, schema_editor):
    set_rls_session_vars(None, is_platform_staff=True)
    Booking = apps.get_model("booking", "Booking")

    taken: dict[str, set[str]] = {}
    for business_id, reference in Booking.all_objects.exclude(reference="").values_list(
        "business_id", "reference"
    ):
        taken.setdefault(str(business_id), set()).add(reference)

    pending = []
    for booking in Booking.all_objects.filter(reference="").only("id", "business_id").iterator():
        seen = taken.setdefault(str(booking.business_id), set())
        for _ in range(_ATTEMPTS):
            reference = _candidate()
            if reference not in seen:
                break
        else:
            raise RuntimeError(
                f"Could not find a free booking reference for business "
                f"{booking.business_id} in {_ATTEMPTS} attempts."
            )
        seen.add(reference)
        booking.reference = reference
        pending.append(booking)
        if len(pending) >= _BATCH:
            Booking.all_objects.bulk_update(pending, ["reference"])
            pending = []
    if pending:
        Booking.all_objects.bulk_update(pending, ["reference"])


def clear(apps, schema_editor):
    """Reverses to blank rather than trying to restore anything.

    There is nothing to restore: before this migration no Booking had a
    reference at all, so blanking them returns the exact prior state.
    """
    set_rls_session_vars(None, is_platform_staff=True)
    Booking = apps.get_model("booking", "Booking")
    Booking.all_objects.update(reference="")


class Migration(migrations.Migration):
    dependencies = [
        ("booking", "0008_booking_reference"),
    ]

    operations = [
        migrations.RunPython(backfill, clear),
        migrations.AddIndex(
            model_name="booking",
            index=models.Index(
                fields=["business", "reference"], name="booking_business_reference"
            ),
        ),
        migrations.AddConstraint(
            model_name="booking",
            constraint=models.UniqueConstraint(
                fields=["business", "reference"],
                name="unique_booking_reference_per_business",
            ),
        ),
    ]
