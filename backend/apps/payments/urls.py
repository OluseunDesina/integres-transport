from django.urls import path

from . import views

urlpatterns = [
    path("payments/", views.PaymentListCreateView.as_view(), name="payment-list-create"),
    path("payments/mine/", views.PaymentIntentMineView.as_view(), name="payment-mine"),
    path("payments/<uuid:pk>/", views.PaymentIntentDetailView.as_view(), name="payment-detail"),
    path("webhooks/paystack/", views.PaystackWebhookView.as_view(), name="paystack-webhook"),
    path(
        "settlement-runs/",
        views.SettlementRunListCreateView.as_view(),
        name="settlement-run-list-create",
    ),
    path(
        "super-admin/businesses/<uuid:pk>/paystack-account/",
        views.PaystackAccountConfigView.as_view(),
        name="paystack-account-config",
    ),
]
