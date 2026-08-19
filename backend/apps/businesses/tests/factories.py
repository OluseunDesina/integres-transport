import factory
import factory.django

from apps.clients.tests.factories import ClientFactory

from ..models import Business


class BusinessFactory(factory.django.DjangoModelFactory):
    class Meta:
        model = Business

    client = factory.SubFactory(ClientFactory)
    vertical = Business.Vertical.SHUTTLE
    name = factory.Faker("company")
    currency = "NGN"
    timezone = "Africa/Lagos"
    booking_mode_default = Business.BookingMode.RESERVATION
