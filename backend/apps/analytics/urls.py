from django.urls import path

from . import views

urlpatterns = [
    path("analytics/dashboard/", views.DashboardView.as_view(), name="analytics-dashboard"),
    path("analytics/revenue/", views.RevenueView.as_view(), name="analytics-revenue"),
    path(
        "analytics/payments/summary/",
        views.PaymentSummaryView.as_view(),
        name="analytics-payment-summary",
    ),
    path(
        "analytics/trips/<uuid:pk>/performance/",
        views.TripPerformanceView.as_view(),
        name="analytics-trip-performance",
    ),
    # Not under `analytics/`: the resources exported are the payments,
    # bookings and revenue surfaces themselves, each gated on its own
    # codename, so hanging them off the analytics prefix would misname
    # what they are.
    path("exports/<str:resource>/", views.ExportView.as_view(), name="analytics-export"),
]
