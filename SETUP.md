# TennisWorld API — Setup

## First-time setup

```bash
cd TennisWorldAPI
npm install
```

## 1. Create the KV namespace (one-time)

```bash
npm run kv:create
# Copy the `id` it prints into wrangler.toml → kv_namespaces[0].id
```

## 2. Set your API key as a secret

```bash
wrangler secret put TENNIS_API_KEY
# Paste your api-tennis.com API key when prompted
```

## 3. Local dev

```bash
npm run dev
# Worker runs at http://localhost:8787
```

Test a route:
```
http://localhost:8787/api/standings?tour=ATP
http://localhost:8787/api/livescore?tour=ATP
http://localhost:8787/api/fixtures?dateStart=2025-05-01&dateStop=2025-05-07
http://localhost:8787/api/players?playerKey=123
http://localhost:8787/api/h2h?playerKeyA=123&playerKeyB=456
http://localhost:8787/api/tournaments?tour=ATP
```

## 4. Deploy

```bash
npm run deploy
# Worker deploys to https://tennisworld-api.<your-account>.workers.dev
# Update CORS_ORIGIN in wrangler.toml to your TennisWorldUI domain
```

---

## Phase 2 — Adding Supabase DB

1. Create a Supabase project at supabase.com
2. Add `SUPABASE_URL` to `wrangler.toml [vars]`
3. `wrangler secret put SUPABASE_SERVICE_KEY`
4. Install: `npm install @supabase/supabase-js`
5. Fill in the stub methods in `src/db.js`

SQL schema (run in Supabase SQL editor):
```sql
create table fixtures (
  match_key      text primary key,
  tournament_key text,
  date           date,
  home_key       text,
  away_key       text,
  home_score     text,
  away_score     text,
  surface        text,
  status         text,
  raw            jsonb,
  fetched_at     timestamptz default now()
);

create table standings_snapshots (
  id          bigserial primary key,
  tour        text,
  snapshot_at date default current_date,
  rows        jsonb,
  unique (tour, snapshot_at)
);

create table players (
  player_key  text primary key,
  name        text,
  country     text,
  profile     jsonb,
  updated_at  timestamptz default now()
);

create table h2h (
  key_low   text,
  key_high  text,
  data      jsonb,
  updated_at timestamptz default now(),
  primary key (key_low, key_high)
);

create table custom_stats (
  player_key      text primary key,
  momentum_score  numeric,
  surface_rating  jsonb,
  computed_at     timestamptz default now()
);
```
