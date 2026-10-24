"""Live streetlight lookup from San Jose DOT's streetlight GIS layer.

The layer is an ArcGIS REST MapServer that supports bounding-box queries, so we
fetch only the lights around the routes being scored. Nothing is preprocessed.
"""

import math
import time

import httpx

# DOT_Streetlight MapServer, layer 5 = "Fixtures: All".
LAYER_URL = "https://geo.sanjoseca.gov/server/rest/services/DOT/DOT_Streetlight/MapServer/5/query"
PAGE_SIZE = 2000
CACHE_SECONDS = 3600
MAX_PAGES = 10  # 20k lights; a walking-route bbox never comes close

# (rounded bbox) -> (fetched_at, lights)
_cache: dict[tuple[float, ...], tuple[float, list[dict]]] = {}


async def fetch_streetlights(min_lng: float, min_lat: float, max_lng: float, max_lat: float) -> list[dict]:
    """Every existing streetlight fixture inside the box, as {lat, lng, lumens, fixture}."""
    # Round outward to ~100 m so near-identical requests share a cache entry.
    key = (
        _floor(min_lng), _floor(min_lat), _ceil(max_lng), _ceil(max_lat),
    )
    cached = _cache.get(key)
    if cached and time.time() - cached[0] < CACHE_SECONDS:
        return cached[1]

    lights: list[dict] = []
    async with httpx.AsyncClient(timeout=30) as client:
        for page in range(MAX_PAGES):
            res = await client.get(LAYER_URL, params={
                "geometry": ",".join(str(v) for v in key),
                "geometryType": "esriGeometryEnvelope",
                "inSR": 4326,
                "outSR": 4326,
                "spatialRel": "esriSpatialRelIntersects",
                "where": "LIGHTSTATUS = 'EXISTING'",
                "outFields": "OBJECTID,LUMENS,LIGHTFIXTURETYPE",
                "orderByFields": "OBJECTID",
                "resultOffset": page * PAGE_SIZE,
                "resultRecordCount": PAGE_SIZE,
                "f": "json",
            })
            res.raise_for_status()
            data = res.json()
            if "error" in data:
                raise RuntimeError(f"Streetlight service error: {data['error']}")
            for f in data.get("features", []):
                g = f.get("geometry")
                if not g:
                    continue
                a = f["attributes"]
                lights.append({
                    "lat": g["y"],
                    "lng": g["x"],
                    "lumens": a.get("LUMENS"),
                    "fixture": a.get("LIGHTFIXTURETYPE"),
                })
            if not data.get("exceededTransferLimit"):
                break

    _cache[key] = (time.time(), lights)
    return lights


def _floor(v: float) -> float:
    return math.floor(v * 1000) / 1000


def _ceil(v: float) -> float:
    return math.ceil(v * 1000) / 1000
