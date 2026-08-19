from django.contrib import admin

from .models import Client, ClientInvitation


@admin.register(Client)
class ClientAdmin(admin.ModelAdmin):
    # KycDocument/WhiteLabelConfig are deliberately NOT admin-registered:
    # admin sessions use cookie auth, not the JWT TenancyMiddleware reads,
    # so RLS would show an always-empty list (see CLAUDE.md's RLS note).
    list_display = ("name", "kyc_status", "is_active", "created_at")
    list_filter = ("kyc_status", "is_active")
    search_fields = ("name", "email")


@admin.register(ClientInvitation)
class ClientInvitationAdmin(admin.ModelAdmin):
    # Safe to register, unlike WhiteLabelConfig above: ClientInvitation
    # isn't a BaseModel subclass, so it isn't RLS-protected — the
    # cookie-auth-resolves-as-anonymous gap doesn't apply here.
    list_display = ("email", "name", "status", "created_at", "expires_at")
    list_filter = ("status",)
    search_fields = ("name", "email")
