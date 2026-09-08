from django.urls import path

from . import views

urlpatterns = [
    path("staff/roles/", views.RoleListView.as_view(), name="staff-role-list"),
    path(
        "staff/invitations/",
        views.StaffInvitationCreateView.as_view(),
        name="staff-invitation-create",
    ),
    path(
        "staff/invitations/<str:token>/",
        views.StaffInvitationResolveView.as_view(),
        name="staff-invitation-resolve",
    ),
    path(
        "staff/invitations/<str:token>/accept/",
        views.StaffInvitationAcceptView.as_view(),
        name="staff-invitation-accept",
    ),
    path("staff/", views.StaffListView.as_view(), name="staff-list"),
    path("staff/<uuid:user_id>/", views.StaffUpdateView.as_view(), name="staff-update"),
    # Not under staff/ — it resolves a *passenger*, and the two must not
    # read as the same directory. See PassengerLookupView.
    path("passengers/lookup/", views.PassengerLookupView.as_view(), name="passenger-lookup"),
]
