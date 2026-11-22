# Garmin Connect connector for Muse

A Cloudflare Worker that lets the [Muse](https://muse.space) personal agent read my Garmin Connect workouts. Muse calls it at most once a day, and the Worker fetches the activities from the Garmin Personal API at that moment. It stores nothing: Muse owns the schedule, the workout rows, and deduplication.

```
Muse ──POST /mcp (Bearer token)──▶ Cloudflare Worker ──ApiKey → JWT──▶ Garmin Personal API
                                        │
                                        └── secrets from Cloudflare Secrets Store
```

It runs on **Workers Free**. A request uses about 1–6 ms of CPU, within the free plan's 10 ms limit. Network wait doesn't count toward that limit. See [PLAN.md](PLAN.md) for the full design and why the Worker is TypeScript rather than Python.

## What it returns

One read-only tool, `get_garmin_activities(start_date, end_date)`. Both dates are inclusive local dates in `YYYY-MM-DD` format, and a window can be at most 31 days.

| Field | Source in Garmin | Notes |
| --- | --- | --- |
| `activity_id` | `activityId` | String. The stable key for deduplication. |
| `start_time_local` | `startTimeLocal` | `YYYY-MM-DDTHH:MM:SS`, local time without a UTC offset. |
| `start_date_local` | — | The date part of `start_time_local`. |
| `activity_type` | `activityType.typeKey` | The exact Garmin key, such as `strength_training`. |
| `activity_type_label` | — | A friendly label, such as `Strength`, `Cardio` or `Running`. |
| `duration_seconds` | `duration` | Timer time, with fractional seconds. |
| `total_calories_kcal` | `calories` | **Active plus resting** workout calories. `null` if Garmin has no value, and `0` for a real zero. |
| `resting_calories_kcal` | `bmrCalories` | Informational only. Never add it to the total. |

Legs of a multisport activity are left out, so the activity counts once. Results are sorted by start time.

## Endpoints

Base URL: `https://garmin-connector.<subdomain>.workers.dev`

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /` | none | Health check that returns the service name and version. |
| `POST /mcp` | token | A stateless MCP server using Streamable HTTP with JSON responses. It supports `initialize`, `notifications/initialized`, `ping`, `tools/list` and `tools/call`. |
| `GET /v1/activities?start_date=…&end_date=…` | token | The same data over plain REST. |

**Authentication:** send `Authorization: Bearer <MUSE_CONNECTOR_TOKEN>`, or `X-Connector-Token: <token>` if the client can only set custom headers. Opening `/mcp` in a browser returns `401`, because a browser sends neither the header nor a `POST`.

**Errors:** MCP tool failures come back as `isError: true` with `{error: {code, message}}`. REST returns the same body with an HTTP status code.

| Code | REST status | Meaning |
| --- | --- | --- |
| `unauthorized` | 401 | Missing or wrong connector token. |
| `invalid_request` | 400 | Bad dates, or a window longer than 31 days. |
| `garmin_key_rejected` | 502 | The Garmin personal API key has expired or was deleted. Renew it (see below). |
| `garmin_throttled` | 503 | Garmin is rate limiting the requests. Includes `Retry-After` when Garmin sends one. |
| `garmin_timeout`, `garmin_unreachable`, `garmin_error`, `garmin_auth_failed`, `garmin_unexpected_response` | 502/504 | Garmin-side failures. Retry the whole window. |
| `window_too_large` | 422 | More than 2,000 activities in the window. Request a smaller window. |

The Worker never returns partial results: if any page from Garmin fails, the whole request fails.

## Setup

1. **Secrets.** In Cloudflare, go to **Secrets Store**. Create these two secrets with the scope **Workers**:
   - `GARMIN_PERSONAL_API_KEY`: create it in Garmin Connect Web under the Personal API settings, and note when it expires.
   - `MUSE_CONNECTOR_TOKEN`: a random value you generate yourself, for example:
     ```bash
     python3 -c "import secrets; print(secrets.token_urlsafe(32))" | pbcopy
     ```
2. **Config.** Put the Secrets Store ID in both `store_id` fields of [`wrangler.jsonc`](wrangler.jsonc). `npx wrangler secrets-store store list --remote` shows it.
3. **Deploy:**
   ```bash
   npm install
   npx wrangler login
   npm test && npm run deploy
   ```
4. **Muse.** Add an **Any MCP server** connector with the URL `https://garmin-connector.<subdomain>.workers.dev/mcp` and the header `Authorization: Bearer <MUSE_CONNECTOR_TOKEN>`. Allow only `get_garmin_activities`.

### Suggested Muse instruction

> Once a day, call `get_garmin_activities` with `start_date` = 6 days ago and `end_date` = today, both in my local timezone. Upsert rows by `activity_id`: Date ← `start_time_local`, Type ← `activity_type_label`, Duration ← `duration_seconds`, Calories ← `total_calories_kcal`. Never add `resting_calories_kcal`. If `isError` is true, write nothing and notify me with the error message.

Asking for 7 days catches workouts that sync late or are edited afterwards. Upserting by `activity_id` makes repeated imports safe.

## Development

```bash
npm test            # vitest unit tests (fake Garmin, no network)
npm run typecheck   # tsc --noEmit
npm run dev         # wrangler dev on http://localhost:8787
npm run deploy      # deploy to Cloudflare
```

`npm run dev` uses the **local** Secrets Store. Create throwaway local values first. Leaving out `--remote` keeps them local:

```bash
npx wrangler secrets-store secret create <store-id> --name MUSE_CONNECTOR_TOKEN --scopes workers
npx wrangler secrets-store secret create <store-id> --name GARMIN_PERSONAL_API_KEY --scopes workers
```

To call the deployed MCP endpoint from a terminal without the token showing on screen or in shell history:

```bash
read -rs "TOKEN?Token: "; echo
curl -s -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_garmin_activities","arguments":{"start_date":"2026-11-15","end_date":"2026-11-21"}}}' \
  https://garmin-connector.<subdomain>.workers.dev/mcp
unset TOKEN
```

To watch live requests and CPU time, run `npx wrangler tail garmin-connector --format json`. The Worker logs only the method, path, status, duration and activity count. It never logs credentials, headers or workout data.

[`scripts/probe_garmin.py`](scripts/probe_garmin.py) is a standalone script that uses only the Python standard library. It checks the live Garmin API's behavior, including pagination, date boundaries, multisport legs and the calorie fields, and prints a sanitized summary.

## Layout

```
src/index.ts     Worker entry: reads secrets, adds request timeouts, logs
src/app.ts       Routing, auth, date validation, REST and MCP handlers
src/garmin.ts    Garmin token exchange, paginated activity search, retries
src/mapping.ts   Garmin activity → workout fields
tests/           Vitest suites with a fake Garmin server and fixtures
scripts/         Live Garmin API check (local only)
```

## Maintenance

- **Renew the Garmin key** when it expires. Keys last 30, 90 or 180 days, or one year, and Garmin emails you about a week before. Create a new key, update `GARMIN_PERSONAL_API_KEY` in the Secrets Store, then run one import. No redeploy is needed.
- **Rotate the Muse token** by generating a new value, updating the Secrets Store, and then updating the Muse connector.
- **Code changes:** run `npm test && npm run deploy`. The URL stays the same, so Muse needs no changes.
