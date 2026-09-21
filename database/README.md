# Database

This directory is the version-controlled database contract for Personal Memory Agent.

## Baseline

`001_baseline.sql` defines the tables, indexes, RLS policies and RPC functions used by the frontend:

- `entries`, `entry_links`, `entry_chunks`, `reviews`, `preferences`
- `pma_search_entries` — keyword search
- `pma_retrieve_entries` — ranked retrieval for Ask
- `pma_replace_links` — atomic relation replacement
- `pma_delete_entry` — atomic entry delete with FK cascades
- `pma_replace_entry_chunks` — atomic chunk refresh

The SQL assumes PostgreSQL and a Supabase-style `auth.uid()` function, which matches the current cloud runtime.

## Rollout

For a **new environment**, apply `001_baseline.sql` top-to-bottom.

For an **existing production database**, do not blindly re-run the baseline. Compare the live schema first, back it up, then port the relevant DDL/functions as a migration. The frontend keeps compatibility fallbacks for the new RPCs so code deployment does not require the database rollout to happen in the same instant.

`entry_chunks` is intentionally text-only for now. It gives long documents a stable chunk model without committing the project to a vector extension or embedding provider before those capabilities are available in the backend.
