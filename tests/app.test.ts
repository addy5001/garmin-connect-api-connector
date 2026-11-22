import { describe, expect, it } from "vitest";
import { handle, SUPPORTED_PROTOCOL_VERSIONS } from "../src/app";
import { TimeoutError, type Http } from "../src/garmin";
import { deps, fakeGarmin, request } from "./helpers";

const Q = { start_date: "2026-11-14", end_date: "2026-11-20" };

describe("auth", () => {
  it("rejects missing and wrong tokens without calling Garmin", async () => {
    const fake = fakeGarmin();
    for (const token of [null, "wrong"]) {
      const res = await handle(request({ query: Q, token }), deps(fake.http));
      expect(res.status).toBe(401);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(fake.calls).toHaveLength(0);
  });

  it("rejects when the Muse token secret is missing", async () => {
    expect((await handle(request({ query: Q }), deps(undefined, ""))).status).toBe(401);
  });

  it("accepts the X-Connector-Token header", async () => {
    const req = request({ query: Q, token: null, headers: { "x-connector-token": "test-muse-token" } });
    expect((await handle(req, deps())).status).toBe(200);
  });
});

describe("REST", () => {
  it("returns mapped activities", async () => {
    const res = await handle(request({ query: Q }), deps());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const data = await res.json<any>();
    expect(data.count).toBe(3);
    expect(data.activities.map((a: any) => a.activity_type)).toEqual(["strength_training", "indoor_cardio", "running"]);
  });

  it("returns an empty list for an empty range", async () => {
    const res = await handle(request({ query: Q }), deps(fakeGarmin({ activities: [] }).http));
    expect(res.status).toBe(200);
    expect((await res.json<any>()).activities).toEqual([]);
  });

  it("paginates until a short page", async () => {
    const many = Array.from({ length: 250 }, (_, i) => ({
      activityId: i,
      startTimeLocal: "2026-11-20 07:00:00",
      activityType: { typeKey: "running" },
    }));
    const fake = fakeGarmin({ activities: many });
    const res = await handle(request({ query: Q }), deps(fake.http));
    expect((await res.json<any>()).count).toBe(250);
    const searches = fake.calls.filter((c) => c.path.endsWith("/activities"));
    expect(searches.map((c) => c.query.get("start"))).toEqual(["0", "100", "200"]);
    expect(searches[0].query.get("startDate")).toBe("2026-11-14");
    expect(searches[0].query.get("endDate")).toBe("2026-11-20");
  });

  it("validates dates", async () => {
    const cases: Record<string, string>[] = [
      {},
      { start_date: "2026-11-20", end_date: "2026-11-14" },
      { start_date: "2026-1-1", end_date: "2026-11-14" },
      { start_date: "2026-02-30", end_date: "2026-03-01" },
      { start_date: "2026-01-01", end_date: "2026-03-01" },
    ];
    for (const query of cases) {
      const res = await handle(request({ query }), deps());
      expect(res.status, JSON.stringify(query)).toBe(400);
      expect((await res.json<any>()).error.code).toBe("invalid_request");
    }
  });

  it("reports an expired Garmin key", async () => {
    const res = await handle(request({ query: Q }), deps(fakeGarmin({ tokenStatus: 401 }).http));
    expect(res.status).toBe(502);
    expect((await res.json<any>()).error.code).toBe("garmin_key_rejected");
  });

  it("passes Retry-After through when throttled", async () => {
    const res = await handle(request({ query: Q }), deps(fakeGarmin({ searchStatuses: [429], retryAfter: "120" }).http));
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("120");
    expect((await res.json<any>()).error.code).toBe("garmin_throttled");
  });

  it("retries a single 5xx", async () => {
    const res = await handle(request({ query: Q }), deps(fakeGarmin({ searchStatuses: [502] }).http));
    expect(res.status).toBe(200);
  });

  it("returns an error, not a partial result, when a page fails", async () => {
    const many = Array.from({ length: 150 }, (_, i) => ({ activityId: i, activityType: { typeKey: "running" } }));
    const fake = fakeGarmin({ activities: many, searchStatuses: [200, 500, 500] });
    const res = await handle(request({ query: Q }), deps(fake.http));
    expect(res.status).toBe(502);
    expect(await res.json<any>()).not.toHaveProperty("activities");
  });

  it("reports timeouts", async () => {
    const slow: Http = async () => {
      throw new TimeoutError();
    };
    const res = await handle(request({ query: Q }), deps(slow));
    expect(res.status).toBe(504);
    expect((await res.json<any>()).error.code).toBe("garmin_timeout");
  });

  it("returns 404 for unknown paths", async () => {
    expect((await handle(request({ path: "/nope" }), deps())).status).toBe(404);
  });
});

async function rpc(method: string, params?: unknown, id: number | null = 1, d = deps()) {
  const msg: Record<string, unknown> = { jsonrpc: "2.0", method };
  if (id !== null) msg.id = id;
  if (params !== undefined) msg.params = params;
  return handle(request({ method: "POST", path: "/mcp", body: JSON.stringify(msg) }), d);
}

describe("MCP", () => {
  it("negotiates the protocol version on initialize", async () => {
    const res = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "muse", version: "1" } });
    const { result } = await res.json<any>();
    expect(result.protocolVersion).toBe("2025-06-18");
    expect(result.capabilities).toEqual({ tools: { listChanged: false } });
    const fallback = await (await rpc("initialize", { protocolVersion: "1999-01-01" })).json<any>();
    expect(fallback.result.protocolVersion).toBe(SUPPORTED_PROTOCOL_VERSIONS[0]);
  });

  it("acknowledges notifications with 202 and no body", async () => {
    const res = await rpc("notifications/initialized", undefined, null);
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("lists the tool", async () => {
    const { result } = await (await rpc("tools/list")).json<any>();
    expect(result.tools.map((t: any) => t.name)).toEqual(["get_garmin_activities"]);
    expect(result.tools[0].annotations.readOnlyHint).toBe(true);
  });

  it("calls the tool", async () => {
    const { result } = await (await rpc("tools/call", { name: "get_garmin_activities", arguments: Q })).json<any>();
    expect(result.isError).toBe(false);
    expect(result.structuredContent.count).toBe(3);
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
  });

  it("reports tool errors in the result", async () => {
    const res = await rpc("tools/call", { name: "get_garmin_activities", arguments: Q }, 1, deps(fakeGarmin({ tokenStatus: 403 }).http));
    const { result } = await res.json<any>();
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error.code).toBe("garmin_key_rejected");
  });

  it("rejects unknown methods and tools", async () => {
    expect((await (await rpc("resources/list")).json<any>()).error.code).toBe(-32601);
    expect((await (await rpc("tools/call", { name: "x" })).json<any>()).error.code).toBe(-32602);
  });

  it("handles parse errors and GET", async () => {
    const bad = await handle(request({ method: "POST", path: "/mcp", body: "{nope" }), deps());
    expect((await bad.json<any>()).error.code).toBe(-32700);
    expect((await handle(request({ method: "GET", path: "/mcp" }), deps())).status).toBe(405);
  });

  it("requires auth", async () => {
    const req = request({ method: "POST", path: "/mcp", token: "bad", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect((await handle(req, deps())).status).toBe(401);
  });
});
