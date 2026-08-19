from django.urls import path

from . import views

urlpatterns = [
    path("ledger/accounts/", views.LedgerAccountListView.as_view(), name="ledger-account-list"),
    path("ledger/entries/", views.JournalEntryListView.as_view(), name="ledger-entry-list"),
]
