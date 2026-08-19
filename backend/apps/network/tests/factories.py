import factory
import factory.django

from apps.businesses.models import Business
from apps.businesses.tests.factories import BusinessFactory

from ..models import Route, RouteStop, Stop


class RouteFactory(factory.django.DjangoModelFactory):
    class Meta:
        model = Route

    client = factory.SubFactory("apps.clients.tests.factories.ClientFactory")
    business = factory.SubFactory(
        BusinessFactory,
        client=factory.SelfAttribute("..client"),
        kyb_status=Business.KybStatus.APPROVED,
    )
    name = factory.Faker("street_name")
    code = ""
    description = ""


class StopFactory(factory.django.DjangoModelFactory):
    class Meta:
        model = Stop

    client = factory.SubFactory("apps.clients.tests.factories.ClientFactory")
    business = factory.SubFactory(BusinessFactory, client=factory.SelfAttribute("..client"))
    name = factory.Faker("street_address")
    address = factory.Faker("address")


class RouteStopFactory(factory.django.DjangoModelFactory):
    class Meta:
        model = RouteStop

    client = factory.SubFactory("apps.clients.tests.factories.ClientFactory")
    route = factory.SubFactory(RouteFactory, client=factory.SelfAttribute("..client"))
    stop = factory.SubFactory(StopFactory, client=factory.SelfAttribute("..client"))
    sequence = 1
