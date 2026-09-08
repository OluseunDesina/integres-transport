import factory
import factory.django

from apps.businesses.tests.factories import BusinessFactory

from ..models import Incident, IncidentActivity


class IncidentFactory(factory.django.DjangoModelFactory):
    class Meta:
        model = Incident

    client = factory.SubFactory("apps.clients.tests.factories.ClientFactory")
    business = factory.SubFactory(BusinessFactory, client=factory.SelfAttribute("..client"))
    # A literal rather than the service's generator: a factory that
    # produced random references would make a uniqueness test assert
    # nothing, since two calls would practically never collide anyway.
    # Tests that care about generation call the service.
    reference = factory.Sequence(lambda n: f"INC-TEST{n:02d}")
    title = factory.Faker("sentence", nb_words=5)
    description = ""
    category = Incident.Category.HARDWARE
    severity = Incident.Severity.MEDIUM
    status = Incident.Status.OPEN
    source = Incident.Source.OPERATOR


class IncidentActivityFactory(factory.django.DjangoModelFactory):
    class Meta:
        model = IncidentActivity

    client = factory.SubFactory("apps.clients.tests.factories.ClientFactory")
    incident = factory.SubFactory(IncidentFactory, client=factory.SelfAttribute("..client"))
    kind = IncidentActivity.Kind.NOTE
    note = "A note."
