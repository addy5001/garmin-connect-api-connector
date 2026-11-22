// Request handling: auth, REST, and a stateless MCP server.
// Uses only standard Request/Response, so it runs unchanged under vitest.

import { fetchActivities, GarminError, type Http } from "./garmin";
import { MappingError, mapActivities, type Workout } from "./mapping";

export const SERVER_NAME = "garmin-connector";
export const SERVER_VERSION = "0.2.0";
export const MAX_WINDOW_DAYS = 31;
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
export const TOOL_NAME = "get_garmin_activities";

export interface Deps {
  museToken: () => Promise<string>;
  garminKey: () => Promise<string>;
  http: Http;
  log?: (msg: string) => void;
}

export interface ActivitiesResult {
  start_date: string;
  end_date: string;
  count: number;
  activities: Workout[];
}

const BASE_HEADERS = { "Cache-Control": "no-store", "Content-Type": "application/json" };

// Error code -> HTTP status for the REST transport.
const ERROR_STATUS: Record<string, number> = {
  invalid_request: 400,
  garmin_key_rejected: 502,
  garmin_auth_failed: 502,
  garmin_error: 502,
  garmin_unexpected_response: 502,
  garmin_unreachable: 502,
  garmin_throttled: 503,
  garmin_timeout: 504,
  window_too_large: 422,
};

export class RequestError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function json(status: number, payload: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), { status, headers: { ...BASE_HEADERS, ...extra } });
}

function error(status: number, code: string, message: string, extra: Record<string, string> = {}): Response {
  return json(status, { error: { code, message } }, extra);
}

function empty(status: number, extra: Record<string, string> = {}): Response {
  return new Response(null, { status, headers: { "Cache-Control": "no-store", ...extra } });
}

// ---------------------------------------------------------------- auth

async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  // Compare fixed-length digests so timing reveals neither content nor length.
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const va = new Uint8Array(da);
  const vb = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

async function authorized(req: Request, deps: Deps): Promise<boolean> {
  const expected = await deps.museToken();
  if (!expected) return false;
  const auth = req.headers.get("authorization") ?? "";
  const presented = auth.slice(0, 7).toLowerCase() === "bearer "
    ? auth.slice(7)
    : (req.headers.get("x-connector-token") ?? "");
  return constantTimeEqual(presented, expected);
}

// ---------------------------------------------------------------- core

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(name: string, value: unknown): number {
  if (typeof value !== "string") throw new RequestError("invalid_request", `${name} is required (YYYY-MM-DD)`);
  const ms = DATE.test(value) ? Date.parse(`${value}T00:00:00Z`) : NaN;
  // Reject impossible dates such as 2026-02-30 (Date.parse would roll them over).
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== value) {
    throw new RequestError("invalid_request", `${name} must be a YYYY-MM-DD date`);
  }
  return ms;
}

export function validateRange(start: unknown, end: unknown): [string, string] {
  const s = parseDate("start_date", start);
  const e = parseDate("end_date", end);
  if (e < s) throw new RequestError("invalid_request", "end_date is before start_date");
  if ((e - s) / 86_400_000 + 1 > MAX_WINDOW_DAYS) {
    throw new RequestError("invalid_request", `window exceeds ${MAX_WINDOW_DAYS} days; split the request`);
  }
  return [start as string, end as string];
}

export async function getActivities(deps: Deps, start: unknown, end: unknown): Promise<ActivitiesResult> {
  const [startDate, endDate] = validateRange(start, end);
  const apiKey = await deps.garminKey();
  if (!apiKey) throw new GarminError("garmin_key_rejected", "GARMIN_PERSONAL_API_KEY is not configured");
  const raw = await fetchActivities(deps.http, apiKey, startDate, endDate);
  let activities: Workout[];
  try {
    activities = mapActivities(raw);
  } catch (err) {
    if (err instanceof MappingError) throw new GarminError("garmin_unexpected_response", err.message);
    throw err;
  }
  return { start_date: startDate, end_date: endDate, count: activities.length, activities };
}

function isKnownError(err: unknown): err is RequestError | GarminError {
  return err instanceof RequestError || err instanceof GarminError;
}

// ---------------------------------------------------------------- REST

async function restActivities(url: URL, deps: Deps): Promise<Response> {
  try {
    const result = await getActivities(deps, url.searchParams.get("start_date") ?? undefined, url.searchParams.get("end_date") ?? undefined);
    deps.log?.(`rest ok count=${result.count}`);
    return json(200, result);
  } catch (err) {
    if (err instanceof RequestError) return error(400, err.code, err.message);
    if (err instanceof GarminError) {
      const extra: Record<string, string> = err.retryAfter ? { "Retry-After": err.retryAfter } : {};
      return error(ERROR_STATUS[err.code] ?? 502, err.code, err.message, extra);
    }
    throw err;
  }
}

// ---------------------------------------------------------------- MCP

const DATE_SCHEMA = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" };

export const TOOL = {
  name: TOOL_NAME,
  title: "Get Garmin activities",
  description:
    "Read-only. Return Garmin Connect workouts whose local start date is within the " +
    "inclusive range start_date..end_date (YYYY-MM-DD, at most 31 days). Each workout has " +
    "activity_id (stable dedupe key), start_time_local, start_date_local, activity_type " +
    "(Garmin key), activity_type_label, duration_seconds, total_calories_kcal (active + " +
    "resting; null if Garmin has none) and resting_calories_kcal (informational; never add " +
    "it to the total).",
  inputSchema: {
    type: "object",
    properties: {
      start_date: { ...DATE_SCHEMA, description: "First local date, inclusive" },
      end_date: { ...DATE_SCHEMA, description: "Last local date, inclusive" },
    },
    required: ["start_date", "end_date"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
};

type Id = string | number | null;

const rpcResult = (id: Id, result: unknown) => json(200, { jsonrpc: "2.0", id, result });
const rpcError = (id: Id, code: number, message: string) => json(200, { jsonrpc: "2.0", id, error: { code, message } });

function toolResult(payload: object, isError: boolean) {
  return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload, isError };
}

async function mcp(req: Request, deps: Deps): Promise<Response> {
  // No server-initiated stream (GET) and no sessions to terminate (DELETE).
  if (req.method !== "POST") return empty(405, { Allow: "POST" });

  let msg: unknown;
  try {
    msg = JSON.parse(await req.text());
  } catch {
    return rpcError(null, -32700, "Parse error");
  }
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return rpcError(null, -32600, "Invalid Request");
  const m = msg as Record<string, unknown>;
  const id = (m.id ?? null) as Id;
  if (m.jsonrpc !== "2.0" || typeof m.method !== "string") return rpcError(id, -32600, "Invalid Request");
  // Notification (e.g. notifications/initialized): acknowledge with no body.
  if (!("id" in m)) return empty(202);

  const params = (m.params ?? {}) as Record<string, unknown>;
  switch (m.method) {
    case "initialize": {
      const requested = params.protocolVersion;
      const version = typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : SUPPORTED_PROTOCOL_VERSIONS[0];
      return rpcResult(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions:
          "Call get_garmin_activities with explicit local dates. Upsert rows by " +
          "activity_id. Use total_calories_kcal as the workout calorie total.",
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: [TOOL] });
    case "tools/call": {
      if (params.name !== TOOL_NAME) return rpcError(id, -32602, `Unknown tool: ${String(params.name)}`);
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      try {
        const result = await getActivities(deps, args.start_date, args.end_date);
        deps.log?.(`mcp tool ok count=${result.count}`);
        return rpcResult(id, toolResult(result, false));
      } catch (err) {
        if (!isKnownError(err)) throw err;
        const e: Record<string, string> = { code: err.code, message: err.message };
        if (err instanceof GarminError && err.retryAfter) e.retry_after = err.retryAfter;
        deps.log?.(`mcp tool error code=${err.code}`);
        return rpcResult(id, toolResult({ error: e }, true));
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${m.method}`);
  }
}

// ---------------------------------------------------------------- entry

export async function handle(req: Request, deps: Deps): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (path === "/" && req.method === "GET") return json(200, { service: SERVER_NAME, version: SERVER_VERSION });
  if (path !== "/mcp" && path !== "/v1/activities") return error(404, "not_found", "Not found");
  // Authenticate before reading the body or calling Garmin.
  if (!(await authorized(req, deps))) {
    return error(401, "unauthorized", "Missing or invalid connector token", { "WWW-Authenticate": "Bearer" });
  }
  if (path === "/mcp") return mcp(req, deps);
  if (req.method !== "GET") return error(405, "method_not_allowed", "Use GET", { Allow: "GET" });
  return restActivities(url, deps);
}
