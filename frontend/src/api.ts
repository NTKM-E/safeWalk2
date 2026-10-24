// Calls to the SafeWalk FastAPI backend.
import { API_URL } from "./config";
import type { ReportType } from "./reportTypes";

export type LngLat = [number, number];

export interface Health {
  vision: boolean;
  storage: "supabase" | "local";
  police_calls: number;
  police_calls_geocoded: number;
  latest_police_call: string | null;
}

export interface CandidateRoute {
  id: string;
  coordinates: LngLat[];
  distance_m: number;
  duration_s: number;
}

export interface ScoredRoute {
  id: string;
  score: number;
  distance_m: number;
  duration_s: number;
  crime: {
    risk: number;
    count: number;
    weighted_per_km: number;
    by_category: Record<string, number>;
    top_call_types: { call_type: string; count: number }[];
    night_count: number;
  };
  lighting: {
    available: boolean;
    risk: number;
    coverage: number | null;
    longest_dark_m: number | null;
    dark_segments: LngLat[][];
  };
  reports: {
    risk: number;
    count: number;
    penalty: number;
    items: { id: string; type: ReportType; status: string; penalty: number }[];
  };
  reasons: { crime: string[]; lighting: string[]; reports: string[] };
}

export interface CrimeMarker {
  id: string;
  lat: number;
  lng: number;
  call_type: string;
  category: string;
  offense_at: string;
  address: string | null;
}

export interface ScoreResult {
  night: boolean;
  crime_data_since: string | null;
  routes: ScoredRoute[];
  crime_markers: CrimeMarker[];
  streetlights: { lat: number; lng: number; lumens: number | null; fixture: string | null }[];
}

export interface Report {
  id: string;
  type: ReportType;
  notes: string;
  photo_url: string;
  reporter_id: string;
  live_photo: boolean;
  ai_type: string | null;
  ai_confidence: number | null;
  ai_description: string | null;
  status: "unverified" | "verified" | "resolved";
  confirm_count: number;
  deny_count: number;
  created_at: string;
  lat: number;
  lng: number;
}

export interface AiSuggestion {
  type: ReportType | "none";
  confidence: number;
  description: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, init);
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (typeof body.detail === "string") detail = body.detail;
    } catch { /* not JSON */ }
    throw new Error(detail);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

export const api = {
  health: () => request<Health>("/api/health"),

  // The server decides day vs night from the current San Jose time.
  score: (routes: CandidateRoute[]) =>
    request<ScoreResult>("/api/score", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ routes }),
    }),

  classify: (photo: Blob) => {
    const form = new FormData();
    form.append("photo", photo, "photo.jpg");
    return request<AiSuggestion>("/api/classify", { method: "POST", body: form });
  },

  listReports: () => request<Report[]>("/api/reports"),

  createReport: (fields: {
    photo: Blob; type: ReportType; lat: number; lng: number; deviceId: string;
    livePhoto: boolean; notes: string; ai: AiSuggestion | null;
  }) => {
    const form = new FormData();
    form.append("photo", fields.photo, "photo.jpg");
    form.append("type", fields.type);
    form.append("lat", String(fields.lat));
    form.append("lng", String(fields.lng));
    form.append("device_id", fields.deviceId);
    form.append("live_photo", String(fields.livePhoto));
    form.append("notes", fields.notes);
    if (fields.ai) {
      form.append("ai_type", fields.ai.type);
      form.append("ai_confidence", String(fields.ai.confidence));
      form.append("ai_description", fields.ai.description);
    }
    return request<Report>("/api/reports", { method: "POST", body: form });
  },

  verify: (reportId: string, deviceId: string, isPresent: boolean) =>
    request<Report>(`/api/reports/${reportId}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: deviceId, is_present: isPresent }),
    }),

  deleteReport: (reportId: string, deviceId: string) =>
    request<void>(`/api/reports/${reportId}?device_id=${deviceId}`, { method: "DELETE" }),
};

/** Photos stored locally by the backend come back as /uploads/... paths. */
export function photoSrc(url: string): string {
  return url.startsWith("/") ? `${API_URL}${url}` : url;
}
