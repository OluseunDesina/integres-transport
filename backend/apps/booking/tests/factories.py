import factory
import factory.django

from apps.scheduling.tests.factories import TripFactory

from ..models import Booking


class BookingFactory(factory.django.DjangoModelFactory):
    class Meta:
        model = Booking

    client = factory.SubFactory("apps.clients.tests.factories.ClientFactory")
    trip = factory.SubFactory(TripFactory, client=factory.SelfAttribute("..client"))
    business = factory.LazyAttribute(lambda o: o.trip.business)
    passenger = factory.SubFactory(
        "apps.identity.tests.factories.PassengerUserFactory",
        client=factory.SelfAttribute("..client"),
    )
    total_amount = "500.00"
    currency = factory.LazyAttribute(lambda o: o.business.currency)
