# Database

The project now uses a normal self-hosted PostgreSQL 16 database. The browser never connects to PostgreSQL directly; only the Hono API has `DATABASE_URL`.

## New installation

The Docker stack mounts `database/001_baseline.sql` into PostgreSQL's initialization directory, so a fresh empty volume is initialized automatically.

Manual setup:

```bash
createdb pma
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/001_baseline.sql
```

The baseline contains:

- `users` — local email/password accounts
- `sessions` — revocable HttpOnly-cookie sessions; only token hashes are stored
- `auth_codes` — one-time email verification challenges
- `entries`, `entry_links`, `entry_chunks`, `reviews`, `preferences`
- `ai_usage` — daily server-side AI quota accounting

## Security boundary

PostgreSQL must stay on a private Docker/network interface. Do not publish port 5432 to the Internet. Every data query in the API includes the authenticated `owner_id`, and all foreign keys cascade on account deletion.

Custom-provider API keys inside `preferences.ai` are encrypted by the API using AES-256-GCM. Configure a stable `PREFERENCES_ENCRYPTION_KEY` before users save those settings; changing that key later makes existing encrypted provider keys unreadable.

## Existing data

Do not point the new server at an old provider-managed database and run this baseline over it. Create a clean self-hosted database, export the user data you want to keep, create the matching local account, then import rows under that local user's new UUID. Keep an offline backup until the migration has been verified.
