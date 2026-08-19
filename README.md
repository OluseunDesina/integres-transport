# Integra AFC Platform

Automated Fare Collection platform for African transport operators (Lagos commuter shuttle, intercity bus, Botswana metro) — one Django/DRF backend, three white-labeled Angular 20 frontends.

This repo is being built phase by phase; see `docs/specs/` for approved specs and `docs/adr/` for architectural decisions. Full contributor/agent guidance lives in `CLAUDE.md`.

## Prerequisites

- Docker + Docker Compose
- Python 3.12 (managed via [uv](https://docs.astral.sh/uv/))
- Node 20 LTS, Angular CLI 20

## Local development

```bash
# Backend + Postgres + Redis + Celery
docker compose up

# Backend tests
cd backend && uv run pytest

# Backend lint / type-check
cd backend && uv run ruff check . && uv run mypy .

# Frontend (from frontend/)
cd frontend && npm install
npm run start:customer       # or start:client-admin / start:super-admin
npm test                     # Karma/Jasmine
npx playwright test          # E2E + axe
```

Test/login credentials for local dev are in [`docs/test-accounts.md`](docs/test-accounts.md).

## Repository layout

```
backend/    Django project (apps/ per bounded domain — see docs/adr/0001)
frontend/   Angular CLI workspace (projects/ — 3 apps + shared libraries)
docs/       specs, ADRs, self-checks, UI review screenshots
```
