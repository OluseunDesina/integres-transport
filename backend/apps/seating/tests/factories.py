import factory
import factory.django

from apps.fleet.tests.factories import VehicleTypeFactory

from ..models import Seat


class SeatFactory(factory.django.DjangoModelFactory):
    class Meta:
        model = Seat

    client = factory.SubFactory("apps.clients.tests.factories.ClientFactory")
    vehicle_type = factory.SubFactory(VehicleTypeFactory, client=factory.SelfAttribute("..client"))
    seat_number = factory.Sequence(lambda n: f"{n + 1}A")
