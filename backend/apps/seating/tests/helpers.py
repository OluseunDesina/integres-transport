"""Shared helpers for seating tests that need a purchase-time fare
snapshot on create_reservation / SeatReservation.objects.create."""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from django.utils import timezone

from apps.fares.models import FareRule


def fare_pricing_for(*, client: Any, route: Any, business: Any) -> dict[str, Any]:
    """Return `{amount, fare_rule}` for an open-ended flat rule on
    `route`, creating one if needed. Reuses the tip so the GiST
    exclusion constraint is not violated by every reservation call."""
    rule = FareRule.objects.filter(route=route, effective_to__isnull=True).first()
    if rule is None:
        rule = FareRule.objects.create(
            client=client,
            business=business,
            route=route,
            amount=Decimal("100.00"),
            effective_from=timezone.now(),
            effective_to=None,
        )
    return {"amount": rule.amount, "fare_rule": rule}
