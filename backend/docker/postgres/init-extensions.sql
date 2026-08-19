-- Enabled now so it's available without a later infrastructure change.
-- Required for the Postgres exclusion-constraint approach to per-segment
-- seat concurrency proposed in docs/adr/0004 (not used until Phase 4).
CREATE EXTENSION IF NOT EXISTS btree_gist;
