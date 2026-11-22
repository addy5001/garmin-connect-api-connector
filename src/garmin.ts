// Minimal Garmin Personal API client.
//
// Endpoints follow Garmin's official client (github.com/garmin/connect-personal-api-python):
// - POST /personalapitoken-service/personal-api/personal-api-key/token with
//   "Authorization: ApiKey <key>"; the body is the raw JWT bearer token (valid 24 h).
// - GET /activitylist-service/activities/search/activities
//   ?start=&limit=&startDate=&endDate= with "Authorization: Bearer <jwt>".
//
// The HTTP transport is injected so tests can supply a fake.

import type { RawActivity } from "./mapping";

export const BASE_URL = "https://personal.connectapi.garmin.com";
export const TOKEN_PATH = "/personalapitoken-service/personal-api/personal-api-key/token";
export const SEARCH_PATH = "/activitylist-service/activities/search/activities";

export const PAGE_SIZE = 100;
// Free-plan budget is 50 subrequests: 1 token + up to MAX_PAGES pages, each
// with at most one retry.
export const MAX_PAGES = 20;

export interface HttpResponse {
  status: number;
  retryAfter: string | null;
  text: string;
}
export type Http = (method: string, url: string, headers: Record<string, string>) => Promise<HttpResponse>;

export class TimeoutError extends Error {}

export class GarminError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryAfter: string | null = null,
  ) {
    super(message);
  }
}

/** Send a request, retrying once on a 5xx response or a transport failure. */
async function request(http: Http, method: string, url: string, headers: Record<string, string>): Promise<HttpResponse> {
  let lastError: unknown = null;
  let last: HttpResponse | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      last = await http(method, url, headers);
      lastError = null;
    } catch (err) {
      if (err instanceof GarminError) throw err;
      lastError = err;
      continue;
    }
    if (last.status >= 500 && attempt === 0) continue;
    return last;
  }
  if (lastError instanceof TimeoutError) throw new GarminError("garmin_timeout", "Garmin did not respond in time");
  if (lastError) {
    const name = lastError instanceof Error ? lastError.name : "Error";
    throw new GarminError("garmin_unreachable", `Garmin request failed: ${name}`);
  }
  return last!; // second 5xx falls through to the status check
}

function raiseForStatus(res: HttpResponse, stage: "token" | "activity search"): void {
  const { status } = res;
  if (status >= 200 && status < 300) return;
  if (status === 401 || status === 403) {
    if (stage === "token") {
      throw new GarminError(
        "garmin_key_rejected",
        "Garmin rejected the personal API key. It has probably expired or been deleted: " +
          "create a new key and update GARMIN_PERSONAL_API_KEY in the Cloudflare Secrets Store.",
      );
    }
    throw new GarminError("garmin_auth_failed", `Garmin rejected the bearer token (HTTP ${status})`);
  }
  if (status === 429) {
    throw new GarminError("garmin_throttled", "Garmin rate-limited the request; retry later", res.retryAfter);
  }
  throw new GarminError("garmin_error", `Garmin returned HTTP ${status} during ${stage}`);
}

export async function getBearerToken(http: Http, apiKey: string, baseUrl = BASE_URL): Promise<string> {
  const res = await request(http, "POST", baseUrl + TOKEN_PATH, { Accept: "*/*", Authorization: `ApiKey ${apiKey}` });
  raiseForStatus(res, "token");
  const token = res.text.trim();
  if (token.split(".").length !== 3) {
    throw new GarminError("garmin_unexpected_response", "token endpoint did not return a JWT");
  }
  return token;
}

function extractPage(text: string): RawActivity[] {
  if (!text.trim()) return [];
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new GarminError("garmin_unexpected_response", "activity search returned invalid JSON");
  }
  if (body && typeof body === "object" && !Array.isArray(body)) {
    // Tolerate a wrapped response; the documented shape is a bare array.
    const obj = body as Record<string, unknown>;
    for (const key of ["activityList", "activities", "results"]) {
      if (Array.isArray(obj[key])) {
        body = obj[key];
        break;
      }
    }
  }
  if (!Array.isArray(body) || !body.every((a) => a && typeof a === "object" && !Array.isArray(a))) {
    throw new GarminError("garmin_unexpected_response", "activity search did not return a list");
  }
  return body as RawActivity[];
}

/**
 * Return every raw activity in the inclusive local date range. Throws on any
 * failed page, so a caller never receives a partial result.
 */
export async function searchActivities(
  http: Http,
  token: string,
  startDate: string,
  endDate: string,
  { baseUrl = BASE_URL, pageSize = PAGE_SIZE, maxPages = MAX_PAGES } = {},
): Promise<RawActivity[]> {
  const headers = { Accept: "application/json", Authorization: `Bearer ${token}` };
  const activities: RawActivity[] = [];
  for (let page = 0; page < maxPages; page++) {
    const query = new URLSearchParams({
      start: String(page * pageSize),
      limit: String(pageSize),
      startDate,
      endDate,
    });
    const res = await request(http, "GET", `${baseUrl}${SEARCH_PATH}?${query}`, headers);
    raiseForStatus(res, "activity search");
    const batch = extractPage(res.text);
    activities.push(...batch);
    if (batch.length < pageSize) return activities;
  }
  throw new GarminError(
    "window_too_large",
    `more than ${maxPages * pageSize} activities in range; request a smaller date window`,
  );
}

export async function fetchActivities(http: Http, apiKey: string, startDate: string, endDate: string) {
  const token = await getBearerToken(http, apiKey);
  return searchActivities(http, token, startDate, endDate);
}
