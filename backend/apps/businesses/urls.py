from django.urls import path

from . import views

urlpatterns = [
    path("businesses/", views.BusinessListCreateView.as_view(), name="business-list-create"),
    path("businesses/<uuid:pk>/", views.BusinessUpdateView.as_view(), name="business-update"),
    path(
        "businesses/<uuid:business_id>/kyb-documents/",
        views.KybDocumentUploadView.as_view(),
        name="business-kyb-document-upload",
    ),
    path(
        "businesses/<uuid:business_id>/directors/",
        views.DirectorListCreateView.as_view(),
        name="business-director-list-create",
    ),
    path(
        "directors/<uuid:pk>/",
        views.DirectorUpdateView.as_view(),
        name="director-update",
    ),
    path(
        "super-admin/businesses/",
        views.BusinessSuperAdminListView.as_view(),
        name="business-super-admin-list",
    ),
    path(
        "super-admin/businesses/<uuid:pk>/seat-hold/",
        views.BusinessSeatHoldView.as_view(),
        name="business-seat-hold",
    ),
    path("super-admin/kyb-queue/", views.KybQueueListView.as_view(), name="kyb-queue-list"),
    path(
        "super-admin/kyb-queue/<uuid:business_id>/decide/",
        views.KybDecideView.as_view(),
        name="kyb-queue-decide",
    ),
]
