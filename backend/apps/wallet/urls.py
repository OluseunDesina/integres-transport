from django.urls import path

from . import views

urlpatterns = [
    path("wallet/mine/", views.WalletMineView.as_view(), name="wallet-mine"),
    path("wallet/", views.WalletLookupView.as_view(), name="wallet-lookup"),
]
