from django.urls import path

from . import views

urlpatterns = [
    path("bookings/", views.BookingListCreateView.as_view(), name="booking-list-create"),
    path("bookings/mine/", views.BookingMineView.as_view(), name="booking-mine"),
    path("bookings/<uuid:pk>/cancel/", views.BookingCancelView.as_view(), name="booking-cancel"),
]
