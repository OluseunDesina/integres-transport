"""VehicleType/Vehicle/Driver for a Business — see
docs/specs/3-network-scheduling-fleet.md §2. Compliance is plain
expiry-date fields, not an upload/review workflow — see
`services.compliance_warnings_for` for the soft, non-blocking warning
this phase surfaces instead of a hard gate.
"""

from django.db import models

from apps.businesses.models import Business
from apps.core.models import BaseModel


class VehicleType(BaseModel):
    business = models.ForeignKey(Business, on_delete=models.PROTECT, related_name="+")
    name = models.CharField(max_length=100)
    capacity = models.PositiveIntegerField()
    is_active = models.BooleanField(default=True)

    class Meta:
        # See apps.network.models.Route's Meta docstring for why this
        # must be restated explicitly rather than omitted: a subclass
        # that declares its own `class Meta` (this one has none of its
        # own options today, but the empty declaration itself already
        # suppresses inheritance) does not automatically inherit
        # BaseModel.Meta's `ordering = ["-created_at"]`.
        ordering = ["-created_at"]

    def __str__(self) -> str:
        return self.name


class Vehicle(BaseModel):
    business = models.ForeignKey(Business, on_delete=models.PROTECT, related_name="+")
    vehicle_type = models.ForeignKey(VehicleType, on_delete=models.PROTECT, related_name="+")
    registration_number = models.CharField(max_length=32)
    insurance_expires_at = models.DateField(null=True, blank=True)
    roadworthiness_expires_at = models.DateField(null=True, blank=True)
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ["-created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["client", "registration_number"],
                name="unique_vehicle_registration_per_client",
            )
        ]

    def __str__(self) -> str:
        return self.registration_number


class Driver(BaseModel):
    business = models.ForeignKey(Business, on_delete=models.PROTECT, related_name="+")
    name = models.CharField(max_length=255)
    phone = models.CharField(max_length=32, blank=True)
    license_number = models.CharField(max_length=64)
    license_expires_at = models.DateField(null=True, blank=True)
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ["-created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["client", "license_number"],
                name="unique_driver_license_per_client",
            )
        ]

    def __str__(self) -> str:
        return self.name
