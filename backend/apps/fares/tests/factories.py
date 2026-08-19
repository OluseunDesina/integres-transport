import factory
import factory.django
from django.utils import timezone

from apps.network.tests.factories import RouteFactory, StopFactory

from ..models import FareRule, FareSegmentRule


class FareRuleFactory(factory.django.DjangoModelFactory):
    class Meta:
        model = FareRule

    client = factory.SubFactory("apps.clients.tests.factories.ClientFactory")
    route = factory.SubFactory(RouteFactory, client=factory.SelfAttribute("..client"))
    business = factory.LazyAttribute(lambda o: o.route.business)
    amount = "500.00"
    effective_from = factory.LazyFunction(timezone.now)
    effective_to = None


class FareSegmentRuleFactory(factory.django.DjangoModelFactory):
    class Meta:
        model = FareSegmentRule

    client = factory.SubFactory("apps.clients.tests.factories.ClientFactory")
    route = factory.SubFactory(RouteFactory, client=factory.SelfAttribute("..client"))
    business = factory.LazyAttribute(lambda o: o.route.business)
    from_stop = factory.LazyAttribute(lambda o: StopFactory(client=o.client, business=o.business))
    to_stop = factory.LazyAttribute(lambda o: StopFactory(client=o.client, business=o.business))
    amount = "200.00"
    effective_from = factory.LazyFunction(timezone.now)
    effective_to = None
