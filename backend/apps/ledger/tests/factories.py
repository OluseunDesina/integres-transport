import factory
import factory.django

from apps.businesses.tests.factories import BusinessFactory
from apps.clients.tests.factories import ClientFactory
from apps.identity.tests.factories import PassengerUserFactory

from ..models import LedgerAccount


class LedgerAccountFactory(factory.django.DjangoModelFactory):
    """Defaults to a `wallet` account — the only type that requires a
    `passenger`. Tests needing another `account_type` should override it
    explicitly and pass `passenger=None` (the `ledger_account_passenger_iff_wallet`
    constraint requires exactly that combination)."""

    class Meta:
        model = LedgerAccount

    client = factory.SubFactory(ClientFactory)
    business = factory.SubFactory(BusinessFactory, client=factory.SelfAttribute("..client"))
    account_type = LedgerAccount.AccountType.WALLET
    passenger = factory.SubFactory(PassengerUserFactory, client=factory.SelfAttribute("..client"))
