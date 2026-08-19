from django.urls import path

from . import views

urlpatterns = [
    path("clients/register/", views.ClientRegistrationView.as_view(), name="client-register"),
    path("clients/me/", views.ClientMeView.as_view(), name="client-me"),
    path(
        "clients/me/kyc-documents/",
        views.KycDocumentUploadView.as_view(),
        name="client-kyc-document-upload",
    ),
    path("super-admin/kyc-queue/", views.KycQueueListView.as_view(), name="kyc-queue-list"),
    path(
        "super-admin/kyc-queue/<uuid:client_id>/decide/",
        views.KycDecideView.as_view(),
        name="kyc-queue-decide",
    ),
    path(
        "super-admin/client-invitations/",
        views.ClientInvitationCreateView.as_view(),
        name="client-invitation-create",
    ),
    path(
        "client-invitations/<str:token>/",
        views.ClientInvitationResolveView.as_view(),
        name="client-invitation-resolve",
    ),
    path(
        "client-invitations/<str:token>/complete/",
        views.ClientInvitationCompleteView.as_view(),
        name="client-invitation-complete",
    ),
    path("white-label/", views.WhiteLabelConfigView.as_view(), name="white-label"),
    path(
        "white-label/resolve/", views.WhiteLabelResolveView.as_view(), name="white-label-resolve"
    ),
]
