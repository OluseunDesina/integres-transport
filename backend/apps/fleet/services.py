"""Fat-service layer for VehicleType/Vehicle/Driver management — mirrors
apps.network.services's shape (see
docs/specs/3-network-scheduling-fleet.md §4)."""

from datetime import date
from typing import Any

from apps.businesses.models import Business
from apps.core.audit import record_audit_event
from apps.identity.models import User

from .models import Driver, Vehicle, VehicleType


def create_vehicle_type(
    *,
    business: Business,
    name: str,
    capacity: int,
    created_by: User,
    trip_class: str = Business.TripClass.STANDARD,
) -> VehicleType:
    vehicle_type = VehicleType.objects.create(
        client=business.client,
        business=business,
        name=name,
        capacity=capacity,
        trip_class=trip_class,
    )
    record_audit_event(actor=created_by, action="vehicle_type.created", target=vehicle_type)
    return vehicle_type


def update_vehicle_type(
    *, vehicle_type: VehicleType, updated_by: User, **fields: Any
) -> VehicleType:
    for field, value in fields.items():
        setattr(vehicle_type, field, value)
    vehicle_type.save(update_fields=list(fields))
    record_audit_event(
        actor=updated_by, action="vehicle_type.updated", target=vehicle_type, **fields
    )
    return vehicle_type


def create_vehicle(
    *,
    business: Business,
    vehicle_type: VehicleType,
    registration_number: str,
    insurance_expires_at: date | None,
    roadworthiness_expires_at: date | None,
    created_by: User,
) -> Vehicle:
    """`vehicle_type.business_id == business.id` is already enforced by
    VehicleCreateSerializer.validate_vehicle_type() before this is
    called — services here assume pre-validated input, matching
    apps.network.services's own documented convention."""
    vehicle = Vehicle.objects.create(
        client=business.client,
        business=business,
        vehicle_type=vehicle_type,
        registration_number=registration_number,
        insurance_expires_at=insurance_expires_at,
        roadworthiness_expires_at=roadworthiness_expires_at,
    )
    record_audit_event(actor=created_by, action="vehicle.created", target=vehicle)
    return vehicle


def update_vehicle(*, vehicle: Vehicle, updated_by: User, **fields: Any) -> Vehicle:
    for field, value in fields.items():
        setattr(vehicle, field, value)
    vehicle.save(update_fields=list(fields))
    record_audit_event(actor=updated_by, action="vehicle.updated", target=vehicle, **fields)
    return vehicle


def create_driver(
    *,
    business: Business,
    name: str,
    phone: str,
    license_number: str,
    license_expires_at: date | None,
    created_by: User,
) -> Driver:
    driver = Driver.objects.create(
        client=business.client,
        business=business,
        name=name,
        phone=phone,
        license_number=license_number,
        license_expires_at=license_expires_at,
    )
    record_audit_event(actor=created_by, action="driver.created", target=driver)
    return driver


def update_driver(*, driver: Driver, updated_by: User, **fields: Any) -> Driver:
    for field, value in fields.items():
        setattr(driver, field, value)
    driver.save(update_fields=list(fields))
    record_audit_event(actor=updated_by, action="driver.updated", target=driver, **fields)
    return driver


def compliance_warnings_for(obj: Vehicle | Driver) -> list[str]:
    """Pure function, no I/O — checks each expiry field against
    date.today(), returns human-readable warning strings. Called from
    both Vehicle/DriverSerializer (GET responses), never persisted —
    this is a soft, visible-only signal this phase, not a hard gate
    (see docs/specs/3-network-scheduling-fleet.md §2's `DECISION`)."""
    today = date.today()
    warnings: list[str] = []
    if isinstance(obj, Vehicle):
        if obj.insurance_expires_at is not None and obj.insurance_expires_at < today:
            warnings.append(f"Vehicle insurance expired on {obj.insurance_expires_at.isoformat()}")
        if (
            obj.roadworthiness_expires_at is not None
            and obj.roadworthiness_expires_at < today
        ):
            warnings.append(
                f"Roadworthiness certificate expired on {obj.roadworthiness_expires_at.isoformat()}"
            )
    else:
        if obj.license_expires_at is not None and obj.license_expires_at < today:
            warnings.append(f"Driver's license expired on {obj.license_expires_at.isoformat()}")
    return warnings
