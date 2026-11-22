// Map Garmin activity summaries to the Muse workout contract.

export interface Workout {
  activity_id: string;
  start_time_local: string | null;
  start_date_local: string | null;
  activity_type: string | null;
  activity_type_label: string | null;
  duration_seconds: number | null;
  /** Total (active + resting) workout calories; null when Garmin has none. */
  total_calories_kcal: number | null;
  /** Resting share, informational only. Never add it to the total. */
  resting_calories_kcal: number | null;
}

export type RawActivity = Record<string, unknown>;

// Friendly labels for common Garmin type keys. Anything else falls back to the
// key itself, title-cased ("trail_running" -> "Trail Running").
const TYPE_LABELS: Record<string, string> = {
  strength_training: "Strength",
  indoor_cardio: "Cardio",
  running: "Running",
  hiit: "HIIT",
  yoga: "Yoga",
  walking: "Walking",
  cycling: "Cycling",
  indoor_cycling: "Indoor Cycling",
  treadmill_running: "Treadmill Running",
  lap_swimming: "Pool Swim",
  open_water_swimming: "Open Water Swim",
};

export class MappingError extends Error {}

export function typeLabel(typeKey: string | null | undefined): string | null {
  if (!typeKey) return null;
  return (
    TYPE_LABELS[typeKey] ??
    typeKey
      .split("_")
      .map((w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
      .join(" ")
  );
}

const LOCAL_TIME = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?$/;

/** Normalize Garmin's "YYYY-MM-DD HH:MM:SS[.f]" to "YYYY-MM-DDTHH:MM:SS" (no offset). */
export function localIso(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const m = LOCAL_TIME.exec(value.trim());
  if (!m) throw new MappingError(`unparseable startTimeLocal: ${JSON.stringify(value)}`);
  return `${m[1]}T${m[2]}`;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** True for a leg of a multisport activity (counted via its parent). */
export function isChildActivity(activity: RawActivity): boolean {
  return Boolean(activity.parentId);
}

export function mapActivity(activity: RawActivity): Workout {
  const id = activity.activityId;
  if (id === null || id === undefined || id === "") throw new MappingError("activity without activityId");
  const type = (activity.activityType ?? {}) as Record<string, unknown>;
  const typeKey = typeof type.typeKey === "string" ? type.typeKey : null;
  const start = localIso(activity.startTimeLocal);
  return {
    activity_id: String(id),
    start_time_local: start,
    start_date_local: start ? start.slice(0, 10) : null,
    activity_type: typeKey,
    activity_type_label: typeLabel(typeKey),
    duration_seconds: num(activity.duration),
    total_calories_kcal: num(activity.calories),
    resting_calories_kcal: num(activity.bmrCalories),
  };
}

export function mapActivities(raw: RawActivity[]): Workout[] {
  // Deduplicate by ID in case a page boundary shifted during pagination.
  const byId = new Map<string, Workout>();
  for (const a of raw) {
    if (isChildActivity(a)) continue;
    const w = mapActivity(a);
    byId.set(w.activity_id, w);
  }
  return [...byId.values()].sort((a, b) => {
    const ka = a.start_time_local ?? "";
    const kb = b.start_time_local ?? "";
    if (ka !== kb) return ka < kb ? -1 : 1;
    return a.activity_id < b.activity_id ? -1 : a.activity_id > b.activity_id ? 1 : 0;
  });
}
