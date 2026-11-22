"""Step 4 of PLAN.md: check live Garmin API behavior and calorie fields.

Standard library only. Prints a sanitized summary (no names, GPS, or tokens).

    GARMIN_PERSONAL_API_KEY=... python3 -I scripts/probe_garmin.py \
        --start-date 2026-11-01 --end-date 2026-11-21 [--detail 21000000001 ...]

or pass --key-file PATH instead of the environment variable.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from urllib.parse import urlencode

BASE = "https://personal.connectapi.garmin.com"
TOKEN_PATH = "/personalapitoken-service/personal-api/personal-api-key/token"
SEARCH_PATH = "/activitylist-service/activities/search/activities"
KEEP = (
    "activityId", "startTimeLocal", "duration", "elapsedDuration", "movingDuration",
    "calories", "bmrCalories", "activeCalories", "parentId", "isParent", "childIds",
)


def call(method, path, headers, params=None):
    url = BASE + path + (f"?{urlencode(params)}" if params else "")
    req = urllib.request.Request(url, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, dict(resp.headers), resp.read().decode()
    except urllib.error.HTTPError as exc:
        return exc.code, dict(exc.headers), exc.read().decode(errors="replace")[:300]


def slim(a):
    out = {k: a[k] for k in KEEP if k in a}
    t = a.get("activityType") or {}
    out["activityType"] = {k: t.get(k) for k in ("typeKey", "typeId", "parentTypeId")}
    if "childIds" in out:
        out["childIds"] = len(out["childIds"] or [])
    return out


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--start-date", required=True)
    p.add_argument("--end-date", required=True)
    p.add_argument("--key-file")
    p.add_argument("--detail", nargs="*", default=[], help="activity IDs to fetch details for")
    args = p.parse_args()

    key = open(args.key_file).read().strip() if args.key_file else os.environ.get("GARMIN_PERSONAL_API_KEY", "").strip()
    if not key:
        sys.exit("Set GARMIN_PERSONAL_API_KEY or pass --key-file")

    print("== token exchange")
    status, headers, text = call("POST", TOKEN_PATH, {"Accept": "*/*", "Authorization": f"ApiKey {key}"})
    print(f"status={status} content-type={headers.get('Content-Type')} looks_like_jwt={text.strip().count('.') == 2}")
    if status != 200:
        print("body:", text[:300])
        return
    auth = {"Accept": "application/json", "Authorization": f"Bearer {text.strip()}"}
    dates = {"startDate": args.start_date, "endDate": args.end_date}

    print("\n== search (limit=100)")
    status, headers, text = call("GET", SEARCH_PATH, auth, {"start": 0, "limit": 100, **dates})
    body = json.loads(text) if status == 200 else text
    print(f"status={status} top-level={type(body).__name__}")
    acts = body if isinstance(body, list) else []
    if isinstance(body, dict):
        print("keys:", sorted(body))
    print(f"count={len(acts)}")
    if acts:
        print("all keys on first activity:", sorted(acts[0]))
    for a in acts:
        print(json.dumps(slim(a)))

    print("\n== excludeChildren=true")
    status, _, text = call("GET", SEARCH_PATH, auth, {"start": 0, "limit": 100, "excludeChildren": "true", **dates})
    print(f"status={status} count={len(json.loads(text)) if status == 200 else text[:200]}")

    print("\n== pagination: limit=1000, then limit=1 start=0/1")
    status, _, text = call("GET", SEARCH_PATH, auth, {"start": 0, "limit": 1000, **dates})
    print(f"limit=1000 status={status} count={len(json.loads(text)) if status == 200 else text[:200]}")
    for start in (0, 1):
        status, _, text = call("GET", SEARCH_PATH, auth, {"start": start, "limit": 1, **dates})
        ids = [a.get("activityId") for a in json.loads(text)] if status == 200 else text[:200]
        print(f"start={start} limit=1 -> {ids}")

    print("\n== date boundary: first and last day only")
    for d in (args.start_date, args.end_date):
        status, _, text = call("GET", SEARCH_PATH, auth, {"start": 0, "limit": 100, "startDate": d, "endDate": d})
        rows = json.loads(text) if status == 200 else []
        print(f"{d}: {[(a.get('activityId'), a.get('startTimeLocal')) for a in rows]}")

    for activity_id in args.detail:
        print(f"\n== detail {activity_id}")
        status, _, text = call("GET", f"/activity-service/activity/{activity_id}", auth)
        if status != 200:
            print(f"status={status} {text[:200]}")
            continue
        summary = json.loads(text).get("summaryDTO") or {}
        print(json.dumps({k: summary.get(k) for k in (
            "calories", "bmrCalories", "activeCalories", "duration", "elapsedDuration", "startTimeLocal")}))


if __name__ == "__main__":
    main()
