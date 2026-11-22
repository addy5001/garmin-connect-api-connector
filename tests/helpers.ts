import fixture from "./fixtures/search_page.json";
import type { Deps } from "../src/app";
import type { Http } from "../src/garmin";
import type { RawActivity } from "../src/mapping";

export const FAKE_JWT = "aaa.bbb.ccc";
export const MUSE_TOKEN = "test-muse-token";
export const GARMIN_KEY = "test-garmin-key";
export const BASE = "https://worker.test";

export const searchPage = (): RawActivity[] => structuredClone(fixture) as RawActivity[];

export interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
}

/** Serves the token endpoint and a paginated activity search. */
export function fakeGarmin(opts: {
  activities?: RawActivity[];
  tokenStatus?: number;
  searchStatuses?: number[];
  retryAfter?: string;
} = {}) {
  const activities = opts.activities ?? searchPage();
  const statuses = [...(opts.searchStatuses ?? [])];
  const calls: Call[] = [];
  const http: Http = async (method, url, headers) => {
    const u = new URL(url);
    calls.push({ method, path: u.pathname, query: u.searchParams });
    if (u.pathname.endsWith("/personal-api-key/token")) {
      if (headers.Authorization !== `ApiKey ${GARMIN_KEY}`) throw new Error("bad api key header");
      const status = opts.tokenStatus ?? 200;
      return { status, retryAfter: null, text: status === 200 ? FAKE_JWT : "denied" };
    }
    if (headers.Authorization !== `Bearer ${FAKE_JWT}`) throw new Error("bad bearer header");
    const status = statuses.shift() ?? 200;
    if (status !== 200) return { status, retryAfter: opts.retryAfter ?? null, text: "error" };
    const start = Number(u.searchParams.get("start"));
    const limit = Number(u.searchParams.get("limit"));
    return { status: 200, retryAfter: null, text: JSON.stringify(activities.slice(start, start + limit)) };
  };
  return { http, calls };
}

export function deps(http: Http = fakeGarmin().http, muse = MUSE_TOKEN, key = GARMIN_KEY): Deps {
  return { museToken: async () => muse, garminKey: async () => key, http };
}

export function request(opts: {
  method?: string;
  path?: string;
  query?: Record<string, string>;
  token?: string | null;
  body?: string;
  headers?: Record<string, string>;
} = {}): Request {
  const url = new URL(opts.path ?? "/v1/activities", BASE);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  const headers = new Headers(opts.headers);
  const token = opts.token === undefined ? MUSE_TOKEN : opts.token;
  if (token) headers.set("authorization", `Bearer ${token}`);
  return new Request(url, { method: opts.method ?? "GET", headers, body: opts.body });
}
