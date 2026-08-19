"""Adversarial RLS proof for apps.payments — mirrors
apps/ledger/tests/test_ledger_rls.py's pattern. The registry-driven
completeness test (apps/core/tests/test_row_level_security.py) picks up
PaystackAccount/PaymentIntent automatically; this file proves RLS
itself, and confirms WebhookEvent is correctly excluded (it isn't a
BaseModel subclass)."""

import pytest
from django.apps import apps as django_apps
from django.db import connection

from apps.clients.tests.factories import ClientFactory
from apps.core.models import BaseModel
from apps.core.rls import set_rls_session_vars
from apps.core.tests.tenancy import tenant_context

from ..models import WebhookEvent
from .factories import PaystackAccountFactory

pytestmark = pytest.mark.django_db


def test_rls_blocks_cross_client_paystack_account_lookup_via_raw_sql() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    with tenant_context(str(client_b.id)):
        account_b = PaystackAccountFactory(client=client_b)

    set_rls_session_vars(str(client_a.id), is_platform_staff=False)
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                'SELECT id FROM "payments_paystackaccount" WHERE id = %s',  # noqa: S608
                [str(account_b.id)],
            )
            assert cursor.fetchone() is None
    finally:
        set_rls_session_vars(None, False)


def test_webhookevent_is_not_a_basemodel_subclass_and_is_excluded_from_rls_registry() -> None:
    assert not issubclass(WebhookEvent, BaseModel)
    concrete_base_model_subclasses = [
        model
        for model in django_apps.get_models()
        if issubclass(model, BaseModel) and not model._meta.abstract
    ]
    assert WebhookEvent not in concrete_base_model_subclasses
