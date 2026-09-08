"""All telemetry business logic — see docs/specs/20-live-operations.md.

`record_positions` is the one write path for a batch of readings,
called identically by the authenticated ingest view
(`apps.telemetry.views.PositionIngestView`, via `record_device_positions`)
and by `simulate_vehicle_positions` (with `device=None`), so the
frontend and every downstream consumer cannot tell the two apart except
by the `source` column each row carries.

Both callers reach RLS-protected rows with no ordinary authenticated
request behind them — a device token is not a JWT, and a management
command has no request at all — so the whole batch runs inside
`platform_staff_bypass()`, matching `apps.payments.services
.process_paystack_webhook`'s own shape.
"""

from __future__ import annotations

import hashlib
import secrets
from datetime import timedelta
from typing import Any

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from apps.businesses.models import Business
from apps.core.audit import record_audit_event
from apps.core.rls import platform_staff_bypass
from apps.fleet.models import Vehicle
from apps.identity.models import User
from apps.scheduling.models import Trip

from .models import TelemetryDevice, VehicleLiveState, VehiclePosition


class InvalidDeviceToken(Exception):
    """Unknown, malformed, or revoked device token — mapped to 401."""


class DeviceNotAssigned(Exception):
    """A device with no vehicle assigned tried to report positions —
    mapped to 409. A device is hardware that gets moved between
    vehicles (`TelemetryDevice.vehicle` is nullable and `SET_NULL` for
    exactly that reason); this is the window in between."""


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def issue_device(
    *, business: Business, label: str, vehicle: Vehicle | None, issued_by: User
) -> tuple[TelemetryDevice, str]:
    """Returns `(device, token)` — `token` is the only time the raw
    value is ever available; only its hash is persisted, the same rule
    `apps.tapngo.services.issue_credential` follows."""
    token = secrets.token_urlsafe(32)
    device = TelemetryDevice.objects.create(
        client=business.client,
        business=business,
        label=label,
        token_hash=_hash_token(token),
        vehicle=vehicle,
    )
    record_audit_event(
        actor=issued_by,
        action="telemetry_device.issued",
        target=device,
        label=label,
        vehicle_id=str(vehicle.id) if vehicle else None,
    )
    return device, token


def update_device(*, device: TelemetryDevice, updated_by: User, **fields: Any) -> TelemetryDevice:
    """Revokes (`is_active=False`) and/or reassigns (`vehicle=`) a
    device. Reassignment only affects rows recorded from here on —
    history already attributed to this device keeps its old vehicle,
    since `VehiclePosition.vehicle` is stamped at ingest time, not
    derived from the device's current state."""
    for field, value in fields.items():
        setattr(device, field, value)
    device.save(update_fields=list(fields))
    metadata = {k: (str(v.id) if isinstance(v, Vehicle) else v) for k, v in fields.items()}
    record_audit_event(
        actor=updated_by, action="telemetry_device.updated", target=device, **metadata
    )
    return device


def authenticate_device(*, raw_token: str) -> TelemetryDevice:
    """Resolves the `Authorization: Device <raw-token>` header to a live
    `TelemetryDevice`, and stamps `last_seen_at` — the one signal
    telemetry can actually answer about device health (spec's
    non-goal: no battery/printer/reader health here, only liveness).
    """
    if not raw_token:
        raise InvalidDeviceToken("Missing device token.")
    with platform_staff_bypass():
        try:
            device = TelemetryDevice.all_objects.select_related("business", "vehicle").get(
                token_hash=_hash_token(raw_token), is_active=True
            )
        except TelemetryDevice.DoesNotExist:
            raise InvalidDeviceToken("Unknown or revoked device token.") from None
        TelemetryDevice.all_objects.filter(pk=device.pk).update(last_seen_at=timezone.now())
    return device


def record_device_positions(
    *, device: TelemetryDevice, readings: list[dict[str, Any]]
) -> dict[str, int]:
    """Vehicle and Business come from the device's own registration,
    never from the request body — a device cannot report on another
    vehicle's behalf."""
    vehicle = device.vehicle
    if vehicle is None:
        raise DeviceNotAssigned("This device is not assigned to a vehicle.")
    return record_positions(
        business=device.business,
        vehicle=vehicle,
        source=VehiclePosition.Source.DEVICE,
        readings=readings,
        device=device,
    )


def record_positions(
    *,
    business: Business,
    vehicle: Vehicle,
    source: str,
    readings: list[dict[str, Any]],
    device: TelemetryDevice | None = None,
) -> dict[str, int]:
    """The one write path for a batch of readings — see the module
    docstring. `readings` is already per-row validated (malformed rows
    are filtered out by the caller before this is reached); this
    function's own job is idempotency, clock-skew flagging, and
    advancing `VehicleLiveState`.

    Idempotent on `(device, recorded_at)`: rather than a read-then-write
    race, correctness comes from the model's own unique constraint plus
    `bulk_create(ignore_conflicts=True)` — the pre-insert existence check
    below exists only so the response can report an accurate `ignored`
    count, not to decide correctness.
    """
    if not readings:
        return {"accepted": 0, "ignored": 0, "flagged_skew": 0}

    now = timezone.now()
    skew_threshold = timedelta(hours=settings.TELEMETRY_CLOCK_SKEW_HOURS)

    with platform_staff_bypass(), transaction.atomic():
        trip = Trip.all_objects.filter(vehicle=vehicle, status=Trip.Status.IN_PROGRESS).first()

        existing_recorded_ats: set[Any] = set()
        if device is not None:
            recorded_ats = [reading["recorded_at"] for reading in readings]
            existing_recorded_ats = set(
                VehiclePosition.all_objects.filter(
                    device=device, recorded_at__in=recorded_ats
                ).values_list("recorded_at", flat=True)
            )

        to_create: list[VehiclePosition] = []
        accepted = 0
        ignored = 0
        flagged_skew = 0
        latest_valid: dict[str, Any] | None = None

        for reading in readings:
            recorded_at = reading["recorded_at"]
            if device is not None and recorded_at in existing_recorded_ats:
                ignored += 1
                continue

            is_skewed = abs(now - recorded_at) > skew_threshold
            if is_skewed:
                flagged_skew += 1

            to_create.append(
                VehiclePosition(
                    client=business.client,
                    business=business,
                    vehicle=vehicle,
                    trip=trip,
                    device=device,
                    source=source,
                    latitude=reading["latitude"],
                    longitude=reading["longitude"],
                    speed_kph=reading.get("speed_kph"),
                    heading_degrees=reading.get("heading_degrees"),
                    recorded_at=recorded_at,
                    received_at=now,
                )
            )
            accepted += 1

            is_later = latest_valid is None or recorded_at > latest_valid["recorded_at"]
            if not is_skewed and is_later:
                latest_valid = reading

        if to_create:
            VehiclePosition.all_objects.bulk_create(to_create, ignore_conflicts=True)

        if latest_valid is not None:
            _advance_live_state(
                business=business, vehicle=vehicle, trip=trip, source=source, reading=latest_valid
            )

    return {"accepted": accepted, "ignored": ignored, "flagged_skew": flagged_skew}


def _advance_live_state(
    *, business: Business, vehicle: Vehicle, trip: Trip | None, source: str, reading: dict[str, Any]
) -> None:
    """Upserts `VehicleLiveState`, and only ever moves it forward — a
    batch arriving out of order must not make the live map jump
    backwards. Not a database constraint: a single device reports for
    one vehicle, so out-of-order arrival is an ordering hazard within
    one caller's own batch, not a cross-caller concurrency problem."""
    recorded_at = reading["recorded_at"]
    defaults = {
        "client": business.client,
        "business": business,
        "trip": trip,
        "source": source,
        "latitude": reading["latitude"],
        "longitude": reading["longitude"],
        "speed_kph": reading.get("speed_kph"),
        "heading_degrees": reading.get("heading_degrees"),
        "recorded_at": recorded_at,
    }
    live_state, created = VehicleLiveState.all_objects.get_or_create(
        vehicle=vehicle, defaults=defaults
    )
    if not created and recorded_at > live_state.recorded_at:
        VehicleLiveState.all_objects.filter(pk=live_state.pk).update(**defaults)


def prune_positions() -> dict[str, Any]:
    """Retention sweep — driven by `POST /internal/tasks/prune-telemetry/`
    since the target hosting has no cron. Reports what it did: a silent
    no-op is the failure mode of every retention job ever written (the
    same lesson `prune_e2e_test_data` names in its own docstring).
    `VehicleLiveState` is never touched — it is bounded by fleet size,
    not by history."""
    cutoff = timezone.now() - timedelta(days=settings.TELEMETRY_RETENTION_DAYS)
    with platform_staff_bypass():
        deleted, _ = VehiclePosition.all_objects.filter(recorded_at__lt=cutoff).delete()
        oldest_remaining = (
            VehiclePosition.all_objects.order_by("recorded_at")
            .values_list("recorded_at", flat=True)
            .first()
        )
    return {
        "deleted": deleted,
        "oldest_remaining": oldest_remaining.isoformat() if oldest_remaining else None,
    }
