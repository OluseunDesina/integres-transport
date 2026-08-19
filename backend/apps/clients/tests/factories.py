import factory
import factory.django

from apps.clients.models import Client


class ClientFactory(factory.django.DjangoModelFactory):
    class Meta:
        model = Client

    name = factory.Faker("company")
