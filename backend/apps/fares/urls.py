from django.urls import path

from . import views

urlpatterns = [
    path("fare-rules/", views.FareRuleListCreateView.as_view(), name="fare-rule-list-create"),
    path("fare-rules/<uuid:pk>/", views.FareRuleUpdateView.as_view(), name="fare-rule-update"),
    path(
        "fare-segment-rules/",
        views.FareSegmentRuleListCreateView.as_view(),
        name="fare-segment-rule-list-create",
    ),
    path(
        "fare-segment-rules/<uuid:pk>/",
        views.FareSegmentRuleUpdateView.as_view(),
        name="fare-segment-rule-update",
    ),
    path("trips/<uuid:pk>/fare/", views.TripFareView.as_view(), name="trip-fare"),
]
