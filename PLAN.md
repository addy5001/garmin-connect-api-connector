# Garmin workout connector for Muse

Deploy a TypeScript Worker on Cloudflare Workers Free (originally Python; see the CPU budget in step 5). Muse invokes it at most once a day and writes the returned workouts to its existing destination. The Worker reads Garmin Connect on demand. Muse owns the schedule, destination rows, and last successful sync date.

## 1. Confirm the Muse invocation path

- Inspect the official Cloudflare connector’s tools in Muse. Use it directly if it can invoke a deployed Worker over HTTPS and supply a private header from stored credentials. Verify this with an authenticated test call before building the Garmin integration.
- If the connector only offers account-management operations (the likely case), expose one read-only tool, `get_garmin_activities(start_date, end_date)`, through a remote MCP endpoint at `https://<worker>.<subdomain>.workers.dev/mcp`. In Muse, select **Any MCP server**, configure the URL and header credential, approve the tool, and grant the Muse agent access. Test tool discovery and invocation over Streamable HTTP.
- Implement only the selected transport. Keep Garmin fetching and field mapping in modules shared by the handler and local tests. [Muse connector setup](https://muse.space/guides/mcp-servers) · [Cloudflare remote MCP guide](https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/)

### MCP implementation

The MCP path uses a small hand-written, stateless handler (`src/app.ts`) rather than Cloudflare's `McpAgent`, which needs Durable Objects:

- `POST /mcp` accepts a single JSON-RPC 2.0 message and returns a single `application/json` response. Don't use SSE streaming, sessions, or Durable Objects.
- Support only `initialize` (return the protocol version, `tools` capability, and server info), `notifications/initialized` (reply `202 Accepted` with no body), `tools/list` (the one tool and its JSON Schema for `start_date` and `end_date`), and `tools/call`. Return JSON-RPC `-32601` for any other method.
- From `tools/call`, return the activities as a text content block containing JSON, with `isError: true` for Garmin or validation failures. Reject an invalid connector token with HTTP 401 before parsing JSON-RPC.
- Answer `GET /mcp` with `405 Method Not Allowed` to show that the server doesn't open a server-to-client stream.

**Fallback:** if Muse's MCP client requires sessions (`Mcp-Session-Id`) or SSE responses, or the hand-written handler fails Muse's tool discovery, replace the transport layer with `McpAgent`. Keep the field mapping and the fixtures from step 4 as the shared specification.

## 2. Define the workout contract

Accept inclusive local start and end dates in `YYYY-MM-DD` format. For direct HTTPS, use `GET /v1/activities?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD`. Return an object containing an `activities` array. A complete search with no matches returns an empty array.

| Output field | Garmin source | Interpretation |
| --- | --- | --- |
| `start_time_local` | `startTimeLocal` | Populate Muse’s Date column with the workout’s local date and time. Preserve seconds and leave the UTC offset unspecified when Garmin omits it. |
| `activity_type` | `activityType.typeKey` | Preserve the specific Garmin key, including new subtypes. Muse can render a friendly label such as Strength, Cardio, or Running. |
| `duration_seconds` | `duration` | Use workout timer seconds and preserve fractional precision. |
| `total_calories_kcal` | Candidate: activity `calories` | Report active plus resting calories for this workout. Verify the mapping in step 4. Preserve a genuine zero and use `null` for a missing total. |
| `activity_id` | `activityId` | Serialize as a string and store alongside Date as the stable import key. |

Field names, pagination, and local date semantics follow the [Garmin Personal API schema](https://developer.garmin.com/gc-developer-program/personal/swagger-docs/).

## 3. Configure secrets and implement the Garmin client

1. Create a personal key in Garmin Connect Web and record its expiry. Generate an independent random token for Muse. Store both in the account-level **Secrets Store** (scope: Workers) as `GARMIN_PERSONAL_API_KEY` and `MUSE_CONNECTOR_TOKEN`, bound in `wrangler.jsonc` through `secrets_store_secrets` with the store ID. The Worker reads them with `await env.<NAME>.get()`. Store only the Muse token in Muse’s connector credential settings. For local development, create throwaway values in the local Secrets Store (`npx wrangler secrets-store secret create <store-id> --name … --scopes workers`, without `--remote`).
2. Authenticate each incoming request against `MUSE_CONNECTOR_TOKEN` (constant-time comparison) before calling Garmin. Validate the date range. Keep credentials, request headers, and workout payloads out of logs.
3. Read `GARMIN_PERSONAL_API_KEY` and send it in the `Authorization: ApiKey <key>` header to `POST https://personal.connectapi.garmin.com/personalapitoken-service/personal-api/personal-api-key/token`. The response body is the raw JWT bearer token (not JSON), valid for 24 hours; this matches Garmin’s official [Python client](https://github.com/garmin/connect-personal-api-python). Keep it in memory for the invocation. When the personal key expires, replace the Cloudflare secret and verify one import. [Garmin authentication and key lifecycle](https://developer.garmin.com/gc-developer-program/personal/personal-faq/) · [Cloudflare secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
4. Call `GET /activitylist-service/activities/search/activities` on the same host with the bearer token. Pass `startDate`, `endDate`, `start`, and `limit`. Advance the offset until the range is exhausted. Use `excludeChildren=true` to count a multisport workout once, if step 4 shows that Garmin honors it. Fetch `GET /activity-service/activity/{activityId}` when a missing or ambiguous field requires detail.
5. Bound outbound timeouts and retries. Distinguish invalid Muse credentials, expired Garmin credentials, throttling, and incomplete pagination. On a failed page, return an error so Muse can retry the full window. Use `Cache-Control: no-store` for workout responses.

## 4. Verify Garmin API behavior and workout calories

### API details

The endpoint paths, header format, and query parameters in step 3 are unconfirmed. Garmin may ignore an unknown query parameter without returning an error, so test each one against the [Personal API schema](https://developer.garmin.com/gc-developer-program/personal/swagger-docs/) and a real call before writing the client:

- **Token exchange:** confirm the endpoint path, the `Authorization: ApiKey <key>` format, the response field holding the bearer token, and its lifetime. Record the error status Garmin returns for an expired or revoked key.
- **`excludeChildren`:** request a range containing a multisport activity with and without the parameter. Use it only if the counts differ as expected. Otherwise, deduplicate child activities by `parentId` or the equivalent field.
- **Date filters:** confirm that `startDate` and `endDate` are inclusive and use the activity's local date. Test a workout that starts just before local midnight.
- **Pagination:** confirm the maximum `limit` and how the last page is signaled. Use the largest accepted limit to save subrequests.
- **Throttling:** record the status code and any `Retry-After` header for rate limiting.

Save the confirmed request and response shapes as sanitized fixtures. If any detail differs from step 3, update step 3 before writing the client.

### Calories

Garmin defines activity calories as the active and resting calories accumulated during a recorded workout. The API describes `calories` in kcal and also exposes `bmrCalories` in workout details. Verify which value matches the workout screen before enabling imports. [Garmin calorie terminology](https://support.garmin.com/en-CA/?faq=lkl4cwCLlK7ox362uGQEV7)

- Select one Strength, one Cardio, and one Running activity. Include a workout with visibly different active and total calories.
- Match each sample by activity ID. Compare the workout screen’s total with list `calories`, detail `summaryDTO.calories`, and detail `summaryDTO.bmrCalories`. Use the list value if it matches across samples. Use the detail value if only that field matches. Investigate any disagreement before releasing the mapping. Adding BMR to an already inclusive total would count resting calories twice.
- Save sanitized fixtures and expected outputs for all three types. Cover a genuine zero and a missing value. Have Muse flag missing calories for review.

## 5. Deploy on Workers Free

The project is a TypeScript Worker with a pinned compatibility date and a fetch handler. Run `npm test` and `npm run typecheck`, try it locally with `npm run dev`, then deploy with `npm run deploy`. Configure the production secrets before connecting Muse. The deployment needs only a Worker and its secrets.

Measure a full seven-day import on the deployed free plan. Workers Free allows 100,000 requests per day, 10 ms of CPU per invocation, and 50 subrequests per invocation. Network wait is excluded from CPU time. Count token exchange, pagination, detail calls, and retries in the subrequest budget. Split large backfills into smaller date windows and report an explicit error if a window cannot be completed. [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)

### CPU budget

Check CPU time per invocation with `npx wrangler tail garmin-connector --format json` (`cpuTime`).

**Result (2026-11-21):** the first Python (Pyodide) build used 12–44 ms of CPU per request, and 14 ms even for an MCP `initialize` that never calls Garmin. That is runtime overhead, not application code, so the plan's fallback applied and the Worker was rewritten in TypeScript. The TypeScript build uses 1–6 ms per request, including a 31-day window with 18 activities, and starts in 3 ms (Python: 534 ms).

If CPU time later approaches 10 ms, avoid detail calls in normal runs and have Muse request shorter windows. Workers Paid ($5/month, 30 s CPU) remains the last resort.

## 6. Import and verify in Muse

- On a normal daily run, request the last seven local calendar dates to catch late uploads and edits. After an extended gap, resume from the last successful date with overlap. Advance the checkpoint only after Muse writes the complete result.
- Update an existing row by activity ID. For historical rows missing an ID, match Date at the precision stored in the destination and cross-check type or duration. Attach the ID only for an unambiguous match. Preserve distinct IDs that share a displayed start time and flag ambiguous legacy matches.
- Test an invalid invocation credential, an expired Garmin key, an empty range, a paginated result, and a failed page followed by a retry. Confirm the failed import leaves the checkpoint in place.
- From Muse, import the three verified workouts twice. Accept the deployment when the second run creates zero duplicates, the Date column preserves local start times, the types and durations agree with Garmin, and each calorie total matches its individual workout screen.
