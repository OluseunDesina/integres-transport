"""Vehicle telemetry — see docs/specs/20-live-operations.md §"Data model
changes". `TelemetryDevice` is the device-auth credential (same
opaque-hashed-token shape as `apps.tapngo.TapCredential`).
`VehiclePosition` is append-only ping history; `VehicleLiveState` is the
one-row-per-vehicle upserted projection the live screen actually reads,
so its cost doesn't grow with position history.

Every FK is `related_name="+"` — see `apps.tapngo.models`'s module
docstring for why: a reverse accessor on an RLS-protected model
traverses `TenantScopedManager`, which silently empties for platform
staff.
"""

from django.db import models

from apps.businesses.models import Business
from apps.core.models import BaseModel
from apps.fleet.models import Vehicle
from apps.scheduling.models import Trip


class TelemetryDevice(BaseModel):
    """A device-auth credential, not the hardware itself. Only
    `token_hash` (SHA-256) is ever stored — the raw token is returned
    once, at issue (`apps.telemetry.services.issue_device`), and never
    again, the same rule `apps.tapngo.services.issue_credential` follows.

    `vehicle` is nullable and `SET_NULL`: a device is hardware that gets
    moved between vehicles, and a swap must not destroy the position
    history already attributed to it.
    """

    business = models.ForeignKey(Business, on_delete=models.PROTECT, related_name="+")
    label = models.CharField(max_length=100)
    token_hash = models.CharField(max_length=64, unique=True)
    vehicle = models.ForeignKey(
        Vehicle, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    is_active = models.BooleanField(default=True)
    last_seen_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self) -> str:
        return self.label


class VehiclePosition(BaseModel):
    """Append-only ping history — by far the highest-write table this
    system has (see the spec's Failure modes: ~26M rows/month at a
    10-second cadence across a hundred vehicles), which is why retention
    (`apps.telemetry.services.prune_positions`) is part of this same
    slice rather than a follow-up.

    Two timestamps, deliberately: `recorded_at` is the device's clock,
    `received_at` is the server's. A device buffering offline and
    uploading an hour later has an accurate `recorded_at` and a late
    `received_at`; conflating the two would make a backfilled batch look
    like the vehicle teleporting in real time.

    Idempotent on `(device, recorded_at)` — see the unique constraint
    below and `apps.telemetry.services.record_positions`'s
    ignore-conflicts bulk insert. `device` is nullable (a simulated row
    has none), and Postgres treats each NULL as distinct for uniqueness
    purposes, so simulated rows are never deduplicated against each
    other by this constraint — deliberate, since the simulator has no
    network retry to guard against.
    """

    class Source(models.TextChoices):
        DEVICE = "device", "Device"
        SIMULATED = "simulated", "Simulated"

    business = models.ForeignKey(Business, on_delete=models.PROTECT, related_name="+")
    vehicle = models.ForeignKey(Vehicle, on_delete=models.PROTECT, related_name="+")
    trip = models.ForeignKey(
        Trip, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    device = models.ForeignKey(
        TelemetryDevice, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    source = models.CharField(max_length=16, choices=Source.choices)
    # Precision matches apps.network.models.Stop exactly rather than
    # introducing a second geographic convention.
    latitude = models.DecimalField(max_digits=9, decimal_places=6)
    longitude = models.DecimalField(max_digits=9, decimal_places=6)
    speed_kph = models.DecimalField(max_digits=6, decimal_places=2, null=True, blank=True)
    heading_degrees = models.PositiveSmallIntegerField(null=True, blank=True)
    recorded_at = models.DateTimeField()
    received_at = models.DateTimeField()

    class Meta:
        ordering = ["-recorded_at"]
        indexes = [models.Index(fields=["vehicle", "-recorded_at"])]
        constraints = [
            models.UniqueConstraint(
                fields=["device", "recorded_at"], name="unique_device_recorded_at"
            )
        ]

    def __str__(self) -> str:
        return f"{self.vehicle_id} @ {self.recorded_at.isoformat()}"


# Module-level, for SPECTACULAR_SETTINGS["ENUM_NAME_OVERRIDES"] — that
# setting resolves a dotted path with import_string, which cannot walk
# into a nested class (see docs/backend-patterns.md §11). "source"
# already collides with apps.incidents.Incident.source's own, different
# choice set.
TELEMETRY_SOURCE_CHOICES = VehiclePosition.Source.choices


class VehicleLiveState(BaseModel):
    """Current position, one row per vehicle — upserted on ingest by
    `apps.telemetry.services.record_positions`. Exists so the live
    screen reads one row per vehicle instead of a `DISTINCT ON` or a
    correlated subquery over an ever-growing `VehiclePosition` table.

    Only ever advanced: a batch arriving out of order must not move this
    backwards. Guarded in the service layer by `recorded_at >
    current.recorded_at`, not by a database constraint — a single
    device reports for one vehicle, so the out-of-order case is an
    ordering hazard within one caller's own batches, not a concurrency
    problem across callers.

    Never pruned — see `apps.telemetry.services.prune_positions`'s
    docstring. Bounded by fleet size, not by history.
    """

    business = models.ForeignKey(Business, on_delete=models.PROTECT, related_name="+")
    vehicle = models.OneToOneField(Vehicle, on_delete=models.CASCADE, related_name="+")
    trip = models.ForeignKey(
        Trip, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    source = models.CharField(max_length=16, choices=VehiclePosition.Source.choices)
    latitude = models.DecimalField(max_digits=9, decimal_places=6)
    longitude = models.DecimalField(max_digits=9, decimal_places=6)
    speed_kph = models.DecimalField(max_digits=6, decimal_places=2, null=True, blank=True)
    heading_degrees = models.PositiveSmallIntegerField(null=True, blank=True)
    recorded_at = models.DateTimeField()

    class Meta:
        ordering = ["-updated_at"]

    def __str__(self) -> str:
        return f"{self.vehicle_id} live @ {self.recorded_at.isoformat()}"
