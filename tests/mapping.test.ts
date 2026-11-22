import { describe, expect, it } from "vitest";
import { mapActivities, mapActivity, typeLabel } from "../src/mapping";
import { searchPage } from "./helpers";

const byId = () => Object.fromEntries(mapActivities(searchPage()).map((w) => [w.activity_id, w]));

describe("mapping", () => {
  it("maps all contract fields", () => {
    expect(mapActivity(searchPage()[0])).toEqual({
      activity_id: "21000000001",
      start_time_local: "2026-11-18T06:30:12",
      start_date_local: "2026-11-18",
      activity_type: "strength_training",
      activity_type_label: "Strength",
      duration_seconds: 3120.457,
      total_calories_kcal: 412.0,
      resting_calories_kcal: 98.0,
    });
  });

  it("never adds BMR to the total", () => {
    expect(mapActivity({ activityId: 1, calories: 500, bmrCalories: 100 }).total_calories_kcal).toBe(500);
  });

  it("preserves zero calories and maps missing to null", () => {
    expect(byId()["21000000002"].total_calories_kcal).toBe(0);
    expect(byId()["21000000003"].total_calories_kcal).toBeNull();
  });

  it("normalizes fractional seconds in the start time", () => {
    expect(byId()["21000000003"].start_time_local).toBe("2026-11-20T07:15:32");
  });

  it("rejects an unparseable start time", () => {
    expect(() => mapActivity({ activityId: 1, startTimeLocal: "yesterday" })).toThrow();
  });

  it("excludes multisport children and sorts by start time", () => {
    expect(mapActivities(searchPage()).map((w) => w.activity_id)).toEqual(["21000000001", "21000000002", "21000000003"]);
  });

  it("collapses duplicate IDs", () => {
    const one = searchPage()[0];
    expect(mapActivities([one, structuredClone(one)])).toHaveLength(1);
  });

  it("labels types", () => {
    expect(typeLabel("indoor_cardio")).toBe("Cardio");
    expect(typeLabel("trail_running")).toBe("Trail Running");
    expect(typeLabel(null)).toBeNull();
  });
});
