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
    # A sequence, not a random draw: `unique_booking_reference_per_business`
    # is real, so two factory bookings in one Business would collide on
    # the blank default. The production path draws a random reference
    # through `apps.booking.services._create_booking_row`; a test only
    # needs distinctness, and a predictable one is easier to assert on.
    reference = factory.Sequence(lambda n: f"BKG-T{n:05d}")
    total_amount = "500.00"
    currency = factory.LazyAttribute(lambda o: o.business.currency)
