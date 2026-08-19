from django.db import models

from apps.core.models import BaseModel


class TenancyProbe(BaseModel):
    """Test-only concrete model, installed only under
    `config.settings.ci`, that exists solely to exercise
    `BaseModel`/`TenantScopedManager`/`TenancyMiddleware` end-to-end
    before any real tenant-owned business model exists (Phase 1+). Once a
    real model plays this role, this probe can be deleted — it is never
    installed in local/staging/production.
    """

    label = models.CharField(max_length=100, default="probe")
