"""Route safety scoring.

For each candidate walking route we look at three things along a narrow corridor:

1. Police calls (PostGIS): pedestrian-relevant calls in the last 90 days within
   50 m, weighted by category, by time of day, and by how recent they are.
   Normalized per km so a route isn't punished just for being longer.
2. Streetlights (live from San Jose DOT GIS): what share of the route is within
   reach of a light, and the longest dark stretch. Counts fully at night only.
3. Community reports (PostGIS): unresolved hazard reports within 40 m, weighted
   by severity, community votes and freshness.

Each factor becomes a 0..1 risk; the weighted sum becomes a 0..100 safety score.
Every route also gets plain-language reasons so users see *why* it was flagged
instead of a neighborhood just being labeled "unsafe".
"""

import json
import math
from collections import Counter
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from pyproj import Transformer
from shapely import STRtree
from shapely.geometry import LineString, Point, mapping
from shapely.ops import transform

from .call_types import CATEGORIES
from .db import pool
from .report_types import REPORT_TYPES, report_penalty
from .streetlights import fetch_streetlights

# ---------- Tunables ----------
CRIME_CORRIDOR_M = 50
REPORT_CORRIDOR_M = 40
CRIME_LOOKBACK_DAYS = 90
CRIME_HALF_LIFE_DAYS = 30
LIGHT_REACH_M = 35          # a point counts as lit within this distance of a fixture
LIGHT_SAMPLE_STEP_M = 15
MIN_ROUTE_KM = 0.3          # floor so very short routes don't get extreme densities
MAX_CRIME_MARKERS = 300

# Max points each factor can take off the score. Lighting matters much less by day.
WEIGHT_CRIME = 40
WEIGHT_REPORTS = 30
WEIGHT_LIGHTING_NIGHT = 30
WEIGHT_LIGHTING_DAY = 5

SAN_JOSE_TZ = ZoneInfo("America/Los_Angeles")
_to_m = Transformer.from_crs("EPSG:4326", "EPSG:32610", always_xy=True).transform  # UTM 10N, meters
_to_deg = Transformer.from_crs("EPSG:32610", "EPSG:4326", always_xy=True).transform


def is_night_hour(hour: int) -> bool:
    return hour >= 19 or hour < 6


# ---------- Police calls ----------
CRIME_SQL = """
select call_number, call_type, category, priority, offense_at, address,
       st_y(geom::geometry) as lat, st_x(geom::geometry) as lng
from police_calls
where geom is not null
  and offense_at > now() - make_interval(days => %(days)s)
  and st_dwithin(geom, st_geomfromgeojson(%(route)s)::geography, %(meters)s)
order by offense_at desc
"""

# The data may not reach back the full lookback (e.g. a small first ingest), so
# explanations name the window the data actually covers.
WINDOW_SQL = """
select min(offense_at) as since from police_calls
where offense_at > now() - make_interval(days => %(days)s)
"""


def window_text(since: datetime | None) -> str:
    if since is None:
        return "(no police call data loaded yet)"
    return f"since {since.astimezone(SAN_JOSE_TZ):%b} {since.astimezone(SAN_JOSE_TZ).day}"


def crime_weight(call: dict, night: bool, now: datetime) -> float:
    """category weight × time-of-day match × recency decay"""
    base = CATEGORIES[call["category"]]["weight"]
    call_night = is_night_hour(call["offense_at"].astimezone(SAN_JOSE_TZ).hour)
    time_factor = 1.0 if call_night == night else 0.5
    age_days = max(0.0, (now - call["offense_at"]).total_seconds() / 86400)
    return base * time_factor * math.pow(2, -age_days / CRIME_HALF_LIFE_DAYS)


def summarize_crime(calls: list[dict], km: float, night: bool, now: datetime) -> dict:
    weighted = sum(crime_weight(c, night, now) for c in calls)
    density = weighted / max(km, MIN_ROUTE_KM)
    by_category = Counter(c["category"] for c in calls)
    top_types = Counter(c["call_type"] for c in calls).most_common(3)
    night_count = sum(is_night_hour(c["offense_at"].astimezone(SAN_JOSE_TZ).hour) for c in calls)
    return {
        "risk": 1 - math.exp(-density / 6),
        "count": len(calls),
        "weighted_per_km": round(density, 2),
        "by_category": {k: by_category.get(k, 0) for k in CATEGORIES},
        "top_call_types": [{"call_type": t, "count": n} for t, n in top_types],
        "night_count": night_count,
    }


def crime_reasons(s: dict, window: str) -> list[str]:
    if not s["count"]:
        return [f"No pedestrian-relevant police calls within {CRIME_CORRIDOR_M} m {window}"]
    parts = [f"{n} {CATEGORIES[k]['label'].lower()}" for k, n in s["by_category"].items() if n]
    text = f"{s['count']} police call{'s' if s['count'] != 1 else ''} nearby {window} ({', '.join(parts)})"
    top = ", ".join(f"{t['call_type'].title()} ×{t['count']}" for t in s["top_call_types"])
    return [text, f"Most common: {top}", f"{s['night_count']} of {s['count']} happened at night"]


# ---------- Streetlights ----------
def summarize_lighting(line_m: LineString, light_tree: STRtree | None) -> dict:
    """Sample the route every few meters and check whether each sample is near a light."""
    if light_tree is None:
        return {"available": False, "risk": 0.0, "coverage": None, "longest_dark_m": None, "dark_segments": []}

    length = line_m.length
    steps = max(1, int(length // LIGHT_SAMPLE_STEP_M))
    samples = [line_m.interpolate(i * length / steps) for i in range(steps + 1)]
    lit = [light_tree.query(p, predicate="dwithin", distance=LIGHT_REACH_M).size > 0 for p in samples]

    # Collect consecutive unlit samples into dark segments.
    dark_segments, run = [], []
    for p, is_lit in zip(samples, lit):
        if not is_lit:
            run.append(p)
        else:
            if len(run) >= 2:
                dark_segments.append(LineString(run))
            run = []
    if len(run) >= 2:
        dark_segments.append(LineString(run))

    coverage = sum(lit) / len(lit)
    longest = max((s.length for s in dark_segments), default=0.0)
    return {
        "available": True,
        "risk": 1 - coverage,
        "coverage": round(coverage, 3),
        "longest_dark_m": round(longest),
        "dark_segments": [mapping(transform(_to_deg, s))["coordinates"] for s in dark_segments],
    }


def lighting_reasons(s: dict) -> list[str]:
    if not s["available"]:
        return ["Streetlight data unavailable right now; lighting not scored"]
    pct = round(s["coverage"] * 100)
    text = f"{pct}% of the route is within {LIGHT_REACH_M} m of a streetlight"
    if s["longest_dark_m"] >= 50:
        text += f"; longest dark stretch {s['longest_dark_m']} m"
    return [text]


# ---------- Community reports ----------
REPORT_SQL = """
select id, type, notes, status, confirm_count, deny_count, created_at,
       st_y(geom::geometry) as lat, st_x(geom::geometry) as lng
from reports
where status <> 'resolved'
  and st_dwithin(geom, st_geomfromgeojson(%(route)s)::geography, %(meters)s)
"""


def summarize_reports(reports: list[dict], night: bool, now: datetime) -> dict:
    penalties = sorted((report_penalty(r, night, now) for r in reports), reverse=True)
    # The worst hazard counts in full; additional ones add less.
    combined = (penalties[0] if penalties else 0) + 0.35 * sum(penalties[1:])
    return {
        "risk": 1 - math.exp(-combined / 8),
        "count": len(reports),
        "penalty": round(combined, 2),
        "items": [
            {"id": str(r["id"]), "type": r["type"], "status": r["status"],
             "penalty": round(report_penalty(r, night, now), 2)}
            for r in reports
        ],
    }


def report_reasons(s: dict) -> list[str]:
    if not s["count"]:
        return ["No active community reports along this route"]
    labels = Counter(
        f"{REPORT_TYPES[i['type']]['label']}{' (verified)' if i['status'] == 'verified' else ''}"
        for i in s["items"]
    )
    return ["Community reports: " + ", ".join(f"{l} ×{n}" if n > 1 else l for l, n in labels.items())]


# ---------- Putting it together ----------
async def score_routes(routes: list[dict], night: bool | None = None) -> dict:
    """routes: [{id, coordinates: [[lng, lat], ...], distance_m, duration_s}]
    night: None = decide from the current time in San Jose."""
    now = datetime.now(timezone.utc)
    if night is None:
        night = is_night_hour(now.astimezone(SAN_JOSE_TZ).hour)
    lines = [LineString(r["coordinates"]) for r in routes]
    lines_m = [transform(_to_m, l) for l in lines]

    # One streetlight fetch covering every route (padded by the light reach).
    pad = 0.0005  # ~50 m
    min_lng = min(l.bounds[0] for l in lines) - pad
    min_lat = min(l.bounds[1] for l in lines) - pad
    max_lng = max(l.bounds[2] for l in lines) + pad
    max_lat = max(l.bounds[3] for l in lines) + pad
    try:
        lights = await fetch_streetlights(min_lng, min_lat, max_lng, max_lat)
        light_points = [transform(_to_m, Point(l["lng"], l["lat"])) for l in lights]
        light_tree = STRtree(light_points)
    except Exception as err:  # the city's GIS server being down shouldn't break routing
        print(f"Streetlight fetch failed: {err!r}")
        lights, light_points, light_tree = [], [], None

    lighting_weight = WEIGHT_LIGHTING_NIGHT if night else WEIGHT_LIGHTING_DAY
    max_risk = WEIGHT_CRIME + WEIGHT_REPORTS + lighting_weight
    scored = []
    crime_markers: dict[str, dict] = {}

    async with pool.connection() as conn:
        since = (await (await conn.execute(WINDOW_SQL, {"days": CRIME_LOOKBACK_DAYS})).fetchone())["since"]
        window = window_text(since)
        for route, line, line_m in zip(routes, lines, lines_m):
            geojson = _geojson(line)
            calls = await (await conn.execute(CRIME_SQL, {
                "route": geojson, "meters": CRIME_CORRIDOR_M, "days": CRIME_LOOKBACK_DAYS,
            })).fetchall()
            reports = await (await conn.execute(REPORT_SQL, {
                "route": geojson, "meters": REPORT_CORRIDOR_M,
            })).fetchall()

            km = line_m.length / 1000
            crime = summarize_crime(calls, km, night, now)
            lighting = summarize_lighting(line_m, light_tree)
            community = summarize_reports(reports, night, now)

            risk = (WEIGHT_CRIME * crime["risk"]
                    + lighting_weight * lighting["risk"]
                    + WEIGHT_REPORTS * community["risk"])
            score = round(100 * (1 - risk / max_risk))

            for c in calls[:MAX_CRIME_MARKERS]:
                crime_markers.setdefault(c["call_number"], {
                    "id": c["call_number"], "lat": c["lat"], "lng": c["lng"],
                    "call_type": c["call_type"], "category": c["category"],
                    "offense_at": c["offense_at"].isoformat(), "address": c["address"],
                })

            scored.append({
                "id": route["id"],
                "score": score,
                "distance_m": route.get("distance_m") or round(line_m.length),
                "duration_s": route.get("duration_s"),
                "crime": crime,
                "lighting": lighting,
                "reports": community,
                "reasons": {
                    "crime": crime_reasons(crime, window),
                    "lighting": lighting_reasons(lighting),
                    "reports": report_reasons(community),
                },
            })

    # Only send the lights that are actually near a route, for drawing on the map.
    route_union = lines_m[0].buffer(LIGHT_REACH_M)
    for l in lines_m[1:]:
        route_union = route_union.union(l.buffer(LIGHT_REACH_M))
    near_lights = [l for l, p in zip(lights, light_points) if route_union.contains(p)]

    return {
        "night": night,
        "crime_data_since": since.isoformat() if since else None,
        "routes": scored,
        "crime_markers": list(crime_markers.values()),
        "streetlights": near_lights,
    }


def _geojson(line: LineString) -> str:
    return json.dumps(mapping(line))
