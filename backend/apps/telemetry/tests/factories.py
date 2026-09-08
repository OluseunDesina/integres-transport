from decimal import Decimal

import factory
import factory.django
from django.utils import timezone

from apps.businesses.tests.factories import BusinessFactory
from apps.fleet.tests.factories import VehicleFactory

from ..models import TelemetryDevice, VehicleLiveState, VehiclePosition


class TelemetryDeviceFactory(factory.django.DjangoModelFactory):
    class Meta:
        model = TelemetryDevice

    client = factory.SubFactory("apps.clients.tests.factories.ClientFactory")
    business = factory.SubFactory(BusinessFactory, client=factory.SelfAttribute("..client"))
    label = factory.Sequence(lambda n: f"Device {n}")
    # A factory never issues through apps.telemetry.services.issue_device
    # (there is no raw token to recover afterwards), so this is a
    # standalone hash a test can't authenticate with directly — tests
    # that need a real bearer token call issue_device() themselves.
    token_hash = factory.Sequence(lambda n: f"{n:064x}"[-64:])
    vehicle = None


class VehiclePositionFactory(factory.django.DjangoModelFactory):
    class Meta:
        model = VehiclePosition

    client = factory.SubFactory("apps.clients.tests.factories.ClientFactory")
    business = factory.SubFactory(BusinessFactory, client=factory.SelfAttribute("..client"))
    vehicle = factory.SubFactory(
        VehicleFactory,
        client=factory.SelfAttribute("..client"),
        business=factory.SelfAttribute("..business"),
    )
    source = VehiclePosition.Source.SIMULATED
    latitude = Decimal("6.524400")
    longitude = Decimal("3.379200")
    recorded_at = factory.LazyFunction(timezone.now)
    received_at = factory.LazyFunction(timezone.now)


class VehicleLiveStateFactory(factory.django.DjangoModelFactory):
    class Meta:
        model = VehicleLiveState

    client = factory.SubFactory("apps.clients.tests.factories.ClientFactory")
    business = factory.SubFactory(BusinessFactory, client=factory.SelfAttribute("..client"))
    vehicle = factory.SubFactory(
        VehicleFactory,
        client=factory.SelfAttribute("..client"),
        business=factory.SelfAttribute("..business"),
    )
    source = VehiclePosition.Source.SIMULATED
    latitude = Decimal("6.524400")
    longitude = Decimal("3.379200")
    recorded_at = factory.LazyFunction(timezone.now)
