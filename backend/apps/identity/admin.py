from django.contrib import admin
from django.contrib.auth.admin import UserAdmin as DjangoUserAdmin

from .models import Permission, User

# Role/StaffInvitation are deliberately NOT admin-registered: they're
# RLS-protected, admin sessions resolve as anonymous (cookie auth, not
# JWT), same gap already documented for KycDocument/Business. Permission
# is platform-wide (no client field, no RLS) — safe to register.


@admin.register(Permission)
class PermissionAdmin(admin.ModelAdmin):
    list_display = ("codename", "description")
    search_fields = ("codename",)


@admin.register(User)
class UserAdmin(DjangoUserAdmin):
    model = User
    list_display = ("email", "client", "is_platform_staff", "is_client_staff", "is_active")
    list_filter = ("is_platform_staff", "is_client_staff", "is_active")
    search_fields = ("email",)
    ordering = ("email",)
    fieldsets = (
        (None, {"fields": ("email", "password")}),
        ("Tenancy", {"fields": ("client", "is_platform_staff", "is_client_staff", "role")}),
        ("Personal info", {"fields": ("first_name", "last_name")}),
        (
            "Permissions",
            {"fields": ("is_active", "is_staff", "is_superuser", "groups", "user_permissions")},
        ),
        ("Important dates", {"fields": ("last_login", "date_joined")}),
    )
    add_fieldsets = (
        (
            None,
            {
                "classes": ("wide",),
                "fields": ("email", "password1", "password2", "client", "is_platform_staff"),
            },
        ),
    )
