// Mapbox Directions (walking) and Geocoding.
//
// Walking alternatives from Mapbox are hit or miss: short urban walks often
// return only one or two routes. So besides asking for alternatives, we also
// request routes through "via" points offset to either side of the straight
// line between start and end, then drop near-duplicates and silly detours.
import type { CandidateRoute, LngLat } from "./api";
import { MAPBOX_TOKEN, SAN_JOSE, SAN_JOSE_BBOX } from "./config";

const DIRECTIONS_URL = "https://api.mapbox.com/directions/v5/mapbox/walking";
const GEOCODE_URL = "https://api.mapbox.com/search/geocode/v6/forward";

const MAX_DETOUR_RATIO = 1.6;  // drop routes taking > 1.6× the fastest
const DUPLICATE_OVERLAP = 0.85; // routes sharing > 85% of their path are duplicates
const OVERLAP_TOLERANCE_M = 25;

interface MapboxRoute {
  geometry: { coordinates: LngLat[] };
  distance: number;
  duration: number;
}

async function directions(points: LngLat[], alternatives: boolean): Promise<MapboxRoute[]> {
  const path = points.map((p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`).join(";");
  const params = new URLSearchParams({
    alternatives: String(alternatives),
    geometries: "geojson",
    overview: "full",
    access_token: MAPBOX_TOKEN,
  });
  const res = await fetch(`${DIRECTIONS_URL}/${path}?${params}`);
  if (!res.ok) throw new Error(`Mapbox Directions returned HTTP ${res.status}`);
  const data = await res.json();
  if (data.code !== "Ok") throw new Error(data.message || `Mapbox Directions: ${data.code}`);
  return data.routes;
}

/** 2–5 distinct walking routes from a to b. */
export async function candidateRoutes(a: LngLat, b: LngLat): Promise<CandidateRoute[]> {
  const straight = distanceM(a, b);
  const offset = Math.min(600, Math.max(150, straight * 0.25));
  const mid = midpoint(a, b);

  const requests = [
    directions([a, b], true),
    directions([a, offsetPoint(mid, a, b, offset), b], false),
    directions([a, offsetPoint(mid, a, b, -offset), b], false),
  ];
  const results = await Promise.allSettled(requests);
  const first = results[0];
  if (first.status === "rejected") throw first.reason;

  const all = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  const fastest = Math.min(...all.map((r) => r.duration));
  const kept: MapboxRoute[] = [];
  for (const route of [...all].sort((x, y) => x.duration - y.duration)) {
    if (route.duration > fastest * MAX_DETOUR_RATIO) continue;
    if (kept.some((k) => overlap(route.geometry.coordinates, k.geometry.coordinates) > DUPLICATE_OVERLAP)) continue;
    kept.push(route);
  }
  return kept.map((r, i) => ({
    id: `r${i}`,
    coordinates: r.geometry.coordinates,
    distance_m: r.distance,
    duration_s: r.duration,
  }));
}

export interface Place {
  name: string;
  detail: string;
  center: LngLat;
}

export async function searchPlaces(query: string, signal?: AbortSignal): Promise<Place[]> {
  const params = new URLSearchParams({
    q: query,
    proximity: SAN_JOSE.join(","),
    bbox: SAN_JOSE_BBOX.join(","),
    autocomplete: "true",
    limit: "5",
    access_token: MAPBOX_TOKEN,
  });
  const res = await fetch(`${GEOCODE_URL}?${params}`, { signal });
  if (!res.ok) throw new Error(`Mapbox Geocoding returned HTTP ${res.status}`);
  const data = await res.json();
  return data.features.map((f: any) => ({
    name: f.properties.name,
    detail: f.properties.place_formatted ?? "",
    center: f.geometry.coordinates as LngLat,
  }));
}

// ---------- Small geometry helpers (equirectangular approximation; fine at walking scale) ----------
const M_PER_DEG_LAT = 111_320;

function mPerDegLng(lat: number): number {
  return M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
}

export function distanceM(a: LngLat, b: LngLat): number {
  const dx = (b[0] - a[0]) * mPerDegLng((a[1] + b[1]) / 2);
  const dy = (b[1] - a[1]) * M_PER_DEG_LAT;
  return Math.hypot(dx, dy);
}

function midpoint(a: LngLat, b: LngLat): LngLat {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

/** Point `meters` to the left (positive) or right (negative) of the a→b line, from p. */
function offsetPoint(p: LngLat, a: LngLat, b: LngLat, meters: number): LngLat {
  const k = mPerDegLng(p[1]);
  const dx = (b[0] - a[0]) * k;
  const dy = (b[1] - a[1]) * M_PER_DEG_LAT;
  const len = Math.hypot(dx, dy) || 1;
  // Perpendicular unit vector (-dy, dx)
  return [p[0] + ((-dy / len) * meters) / k, p[1] + ((dx / len) * meters) / M_PER_DEG_LAT];
}

function distToSegmentM(p: LngLat, a: LngLat, b: LngLat): number {
  const k = mPerDegLng(p[1]);
  const ax = (a[0] - p[0]) * k, ay = (a[1] - p[1]) * M_PER_DEG_LAT;
  const bx = (b[0] - p[0]) * k, by = (b[1] - p[1]) * M_PER_DEG_LAT;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}

/** Share of route x's vertices that lie within OVERLAP_TOLERANCE_M of route y. */
function overlap(x: LngLat[], y: LngLat[]): number {
  let near = 0;
  for (const p of x) {
    for (let i = 1; i < y.length; i++) {
      if (distToSegmentM(p, y[i - 1], y[i]) <= OVERLAP_TOLERANCE_M) { near++; break; }
    }
  }
  return near / x.length;
}
