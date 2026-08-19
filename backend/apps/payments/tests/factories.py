import factory
import factory.django

from apps.booking.tests.factories import BookingFactory
from apps.businesses.tests.factories import BusinessFactory
from apps.clients.tests.factories import ClientFactory

from ..models import PaymentIntent, PaystackAccount


class PaystackAccountFactory(factory.django.DjangoModelFactory):
    class Meta:
        model = PaystackAccount

    client = factory.SubFactory(ClientFactory)
    business = factory.SubFactory(BusinessFactory, client=factory.SelfAttribute("..client"))
    bank_code = "058"
    account_number = "0123456789"
    account_name = "Test Business"
    is_active = True


class PaymentIntentFactory(factory.django.DjangoModelFactory):
    class Meta:
        model = PaymentIntent

    client = factory.SubFactory(ClientFactory)
    booking = factory.SubFactory(BookingFactory, client=factory.SelfAttribute("..client"))
    business = factory.LazyAttribute(lambda o: o.booking.business)
    passenger = factory.LazyAttribute(lambda o: o.booking.passenger)
    amount = factory.LazyAttribute(lambda o: o.booking.total_amount)
    currency = factory.LazyAttribute(lambda o: o.booking.currency)
    status = PaymentIntent.Status.PENDING
    psp_provider = "paystack"
    psp_reference = factory.Sequence(lambda n: f"test-paystack-ref-{n}")
