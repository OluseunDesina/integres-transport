import factory
import factory.django

from apps.businesses.tests.factories import BusinessFactory

from ..models import Driver, Vehicle, VehicleType


class VehicleTypeFactory(factory.django.DjangoModelFactory):
    class Meta:
        model = VehicleType

    client = factory.SubFactory("apps.clients.tests.factories.ClientFactory")
    business = factory.SubFactory(BusinessFactory, client=factory.SelfAttribute("..client"))
    name = factory.Faker("word")
    capacity = 33


class VehicleFactory(factory.django.DjangoModelFactory):
    class Meta:
        model = Vehicle

    client = factory.SubFactory("apps.clients.tests.factories.ClientFactory")
    business = factory.SubFactory(BusinessFactory, client=factory.SelfAttribute("..client"))
    vehicle_type = factory.SubFactory(
        VehicleTypeFactory,
        client=factory.SelfAttribute("..client"),
        business=factory.SelfAttribute("..business"),
    )
    registration_number = factory.Sequence(lambda n: f"LAG-{n:04d}-XY")


class DriverFactory(factory.django.DjangoModelFactory):
    class Meta:
        model = Driver

    client = factory.SubFactory("apps.clients.tests.factories.ClientFactory")
    business = factory.SubFactory(BusinessFactory, client=factory.SelfAttribute("..client"))
    name = factory.Faker("name")
    license_number = factory.Sequence(lambda n: f"DL-{n:06d}")
