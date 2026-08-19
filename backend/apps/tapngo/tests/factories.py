import factory
import factory.django

from ..models import TapCredential


class TapCredentialFactory(factory.django.DjangoModelFactory):
    class Meta:
        model = TapCredential

    client = factory.SubFactory("apps.clients.tests.factories.ClientFactory")
    passenger = factory.SubFactory(
        "apps.identity.tests.factories.PassengerUserFactory",
        client=factory.SelfAttribute("..client"),
    )
    token_hash = factory.Sequence(lambda n: f"test-token-hash-{n}")
    channel = TapCredential.Channel.QR
    label = ""
