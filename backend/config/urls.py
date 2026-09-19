from django.conf import settings
from django.conf.urls.static import static
from django.contrib import admin
from django.urls import include, path
from drf_spectacular.views import SpectacularAPIView, SpectacularSwaggerView

urlpatterns = [
    path("admin/", admin.site.urls),
    path("api/v1/", include("apps.core.urls")),
    path("api/v1/", include("apps.clients.urls")),
    path("api/v1/", include("apps.businesses.urls")),
    path("api/v1/", include("apps.network.urls")),
    path("api/v1/", include("apps.fleet.urls")),
    path("api/v1/", include("apps.scheduling.urls")),
    path("api/v1/", include("apps.fares.urls")),
    path("api/v1/", include("apps.seating.urls")),
    path("api/v1/", include("apps.booking.urls")),
    path("api/v1/", include("apps.tapngo.urls")),
    path("api/v1/", include("apps.ledger.urls")),
    path("api/v1/", include("apps.payments.urls")),
    path("api/v1/", include("apps.wallet.urls")),
    path("api/v1/", include("apps.ticketing.urls")),
    path("api/v1/", include("apps.notifications.urls")),
    path("api/v1/", include("apps.incidents.urls")),
    path("api/v1/", include("apps.analytics.urls")),
    path("api/v1/", include("apps.telemetry.urls")),
    path("api/v1/", include("apps.activity.urls")),
    path("api/v1/", include("apps.marketplace.urls")),
    path("api/v1/", include("apps.identity.staff_urls")),
    path("api/v1/auth/", include("apps.identity.urls")),
    path("api/v1/schema/", SpectacularAPIView.as_view(), name="schema"),
    path("api/v1/docs/", SpectacularSwaggerView.as_view(url_name="schema"), name="swagger-ui"),
]

if settings.DEBUG:
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
