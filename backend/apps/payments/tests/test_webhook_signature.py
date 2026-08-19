"""Webhook signature verification — docs/specs/5-payments-wallet-ledger.md
edge case 8. `WebhookEvent` is a plain (non-BaseModel) model, readable
without any tenancy context, matching `AuditLog`'s own precedent."""

import pytest
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from ..models import WebhookEvent
from .webhook_helpers import paystack_payload, signed_body

pytestmark = pytest.mark.django_db


def test_valid_signature_is_accepted_and_recorded() -> None:
    raw_body, signature = signed_body(paystack_payload(event="charge.success", reference="ref-1"))

    response = APIClient().post(
        reverse("paystack-webhook"),
        data=raw_body,
        content_type="application/json",
        HTTP_X_PAYSTACK_SIGNATURE=signature,
    )

    assert response.status_code == status.HTTP_200_OK
    event = WebhookEvent.objects.get(reference="ref-1", event_type="charge.success")
    assert event.signature_valid is True


def test_invalid_signature_is_rejected_and_nothing_is_written() -> None:
    raw_body, _valid_signature = signed_body(
        paystack_payload(event="charge.success", reference="ref-2")
    )

    response = APIClient().post(
        reverse("paystack-webhook"),
        data=raw_body,
        content_type="application/json",
        HTTP_X_PAYSTACK_SIGNATURE="not-the-real-signature",
    )

    assert response.status_code == status.HTTP_401_UNAUTHORIZED
    assert WebhookEvent.objects.filter(reference="ref-2").count() == 0


def test_missing_signature_is_rejected_and_nothing_is_written() -> None:
    raw_body, _signature = signed_body(paystack_payload(event="charge.success", reference="ref-3"))

    response = APIClient().post(
        reverse("paystack-webhook"), data=raw_body, content_type="application/json"
    )

    assert response.status_code == status.HTTP_401_UNAUTHORIZED
    assert WebhookEvent.objects.filter(reference="ref-3").count() == 0
