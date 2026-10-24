export const MAPBOX_TOKEN: string = import.meta.env.VITE_MAPBOX_TOKEN ?? "";
export const API_URL: string = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");

export const SAN_JOSE: [number, number] = [-121.8863, 37.3382]; // [lng, lat]
// Search results and map are limited to roughly the city.
export const SAN_JOSE_BBOX: [number, number, number, number] = [-122.05, 37.12, -121.58, 37.47];

// Route line colors by safety score.
export function scoreColor(score: number): string {
  if (score >= 75) return "#15803d";
  if (score >= 55) return "#d97706";
  return "#dc2626";
}

/** Same rule as the backend (scoring.is_night_hour), in San Jose time. */
export function isNightInSanJose(d = new Date()): boolean {
  const h = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: "America/Los_Angeles" }).format(d));
  return h >= 19 || h < 6;
}
