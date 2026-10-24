# SafeWalk — San Jose

Walking navigation that compares 2–3 routes by safety instead of just speed. Each route is scored on:

- **Police calls**: San Jose PD [Police Calls for Service](https://data.sanjoseca.gov/dataset/police-calls-for-service), filtered to call types that matter for pedestrians (assault, robbery, weapons, disturbances, theft…), weighted by type, time of day and recency.
- **Streetlights**: San Jose DOT's [streetlight GIS layer](https://geo.sanjoseca.gov/server/rest/services/DOT/DOT_Streetlight/MapServer), fetched live for the area around each route.
- **Community reports**: photos of broken lights, damaged sidewalks or blocked paths, classified by Gemini and verified by people walking past.

Every route shows *why* it scored the way it did, so a neighborhood is never just labeled "unsafe".

```
frontend/   React + TypeScript + Vite + Mapbox GL JS
backend/    Python FastAPI: route scoring, reports, Gemini photo classification
  ingest/   nightly job: pull police calls → geocode → Postgres
db/         Postgres + PostGIS schema (Supabase in production)
```

## How it works

1. A nightly job (`backend/ingest/police_calls.py`) asks the city's CKAN Data API for recent pedestrian-relevant calls only, rather than downloading the full yearly CSV. It geocodes new block-level addresses with the **City of San Jose's own locator**, which also handles `X ST & Y ST` intersections, caches them, and writes the calls to PostGIS.
2. The user picks a start and end point. The frontend asks Mapbox for walking routes, plus extra routes through "via" points on either side of the straight line because Mapbox often returns only one walking route. It then drops near-duplicates.
3. The frontend sends the route shapes to `POST /api/score`. The backend runs PostGIS `ST_DWithin` queries for police calls (50 m) and reports (40 m), fetches streetlights for the routes' bounding box, and returns a 0–100 score, a breakdown and reasons for each route.
4. The map shows the routes color-coded by score (Safest / Balanced / Fastest), police call dots, streetlights, and the unlit stretches of the selected route.
5. **Reporting**: take or upload a photo → Gemini suggests a type → confirm → it's placed at your GPS location or wherever you click the map. Routes are re-scored immediately. When someone else walks within 40 m they're asked "Is this hazard still here?". One confirmation marks a report verified. At least two denials, outnumbering the confirmations, resolve it and remove it from the map.

### Scoring (backend/app/scoring.py)

| Factor | Risk 0–1 | Max points off |
|---|---|---|
| Police calls | `1 − e^(−weighted calls per km / 6)`; violent/weapons ×3, disorder ×1, property ×0.5; calls at the same time of day as the walk count full, others half; 30-day half-life | 40 |
| Lighting | share of the route more than 35 m from a streetlight | 30 at night, 5 by day |
| Community reports | severity × night multiplier × vote confidence × freshness | 30 |

Safety score = `100 × (1 − total risk points / max points)`. Night (7 pm–6 am) is decided from the current San Jose time, and open routes are re-scored when it changes.

## Setup

You need Docker (for local Postgres), Python 3.11+, Node 20+, a [Mapbox token](https://account.mapbox.com/access-tokens/), and optionally a [Gemini API key](https://aistudio.google.com/apikey) for AI photo classification.

```bash
# 1. Database (local PostGIS; schema loads automatically on first start)
docker compose up -d

# 2. Backend
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env            # add GEMINI_API_KEY to enable AI suggestions
python -m ingest.police_calls   # last 30 days, max 2000 calls: a small sample
uvicorn app.main:app --reload   # http://localhost:8000/docs

# 3. Frontend (new terminal)
cd frontend
cp .env.example .env.         # add VITE_MAPBOX_TOKEN
npm install
npm run dev                     # http://localhost:5173
```

Add `?demo` to the URL to set your "current position" by right-clicking the map. This lets you test the "Is this hazard still here?" prompt without walking anywhere.

### Police data volume

The default ingest is deliberately small. 2,000 calls covers only about the last 10–14 days citywide, and route explanations name the window the data actually covers. To load more, once you're ready:

```bash
python -m ingest.police_calls --days 90 --limit 30000
```

Re-running is safe because rows are upserted, and the geocode cache means only new addresses hit the geocoder. For a nightly job:

```cron
15 3 * * *  cd /path/to/safeWalk2/backend && .venv/bin/python -m ingest.police_calls --days 3 --limit 5000
```

### Using Supabase instead of local Postgres

1. Create a project, open **SQL Editor**, paste `db/schema.sql`, and run it.
2. Set `DATABASE_URL` in `backend/.env` to the project's connection string (Project Settings → Database).
3. For photo storage, create a **public** Storage bucket named `report-photos` and set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. Without these, photos are saved to `backend/uploads/`.

All database access goes through the backend. RLS is enabled with no policies, so the public anon key can't read or write the tables.

### Deploying

Put the frontend on Vercel with `VITE_MAPBOX_TOKEN` and `VITE_API_URL` pointing at the backend. Put the backend on Render or Railway with the `backend/.env` variables, and add the frontend URL to `CORS_ORIGINS`.

## Tests

```bash
cd backend && pytest
cd frontend && npm run typecheck
```
