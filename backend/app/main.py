"""SafeWalk API.

Run from backend/:  uvicorn app.main:app --reload
Docs:               http://localhost:8000/docs
"""

from contextlib import asynccontextmanager
from uuid import UUID

import psycopg
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .config import settings
from .db import pool
from .report_types import REPORT_TYPES
from .scoring import score_routes
from .storage import save_photo, using_supabase
from .vision import VisionError, classify_image, vision_enabled

MAX_PHOTO_BYTES = 5 * 1024 * 1024
MAX_ROUTES = 6
MAX_ROUTE_POINTS = 5000
# Generous box around San Jose; reports outside it are rejected.
SJ_BOUNDS = {"min_lng": -122.2, "max_lng": -121.5, "min_lat": 37.1, "max_lat": 37.5}


@asynccontextmanager
async def lifespan(_: FastAPI):
    await pool.open()
    yield
    await pool.close()


app = FastAPI(title="SafeWalk API", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.cors_origins),
    allow_methods=["*"],
    allow_headers=["*"],
)
settings.uploads_dir.mkdir(parents=True, exist_ok=True)
app.mount("/uploads", StaticFiles(directory=settings.uploads_dir), name="uploads")


# ---------- Status ----------
@app.get("/api/health")
async def health():
    async with pool.connection() as conn:
        row = await (await conn.execute(
            "select count(*) as calls, count(geom) as geocoded, max(offense_at) as latest from police_calls"
        )).fetchone()
    return {
        "vision": vision_enabled(),
        "storage": "supabase" if using_supabase() else "local",
        "police_calls": row["calls"],
        "police_calls_geocoded": row["geocoded"],
        "latest_police_call": row["latest"],
    }


# ---------- Route scoring ----------
class RouteIn(BaseModel):
    id: str
    coordinates: list[tuple[float, float]] = Field(min_length=2, max_length=MAX_ROUTE_POINTS)
    distance_m: float | None = None
    duration_s: float | None = None


class ScoreIn(BaseModel):
    routes: list[RouteIn] = Field(min_length=1, max_length=MAX_ROUTES)
    # Normally omitted: the server decides from the current San Jose time. Set it to test day vs night.
    night: bool | None = None


@app.post("/api/score")
async def score(body: ScoreIn):
    return await score_routes([r.model_dump() for r in body.routes], body.night)


# ---------- Community reports ----------
REPORT_COLUMNS = """
    id, type, notes, photo_url, reporter_id, live_photo, ai_type, ai_confidence, ai_description,
    status, confirm_count, deny_count, created_at,
    st_y(geom::geometry) as lat, st_x(geom::geometry) as lng
"""


async def read_photo(photo: UploadFile) -> bytes:
    if not (photo.content_type or "").startswith("image/"):
        raise HTTPException(400, "That file isn't an image.")
    data = await photo.read()
    if len(data) > MAX_PHOTO_BYTES:
        raise HTTPException(413, "Photo is too large (5 MB max).")
    return data


@app.post("/api/classify")
async def classify(photo: UploadFile = File(...)):
    data = await read_photo(photo)
    try:
        return await classify_image(data, photo.content_type or "image/jpeg")
    except VisionError as err:
        raise HTTPException(503, str(err)) from err


@app.get("/api/reports")
async def list_reports():
    async with pool.connection() as conn:
        return await (await conn.execute(
            f"select {REPORT_COLUMNS} from reports where status <> 'resolved' order by created_at"
        )).fetchall()


@app.post("/api/reports", status_code=201)
async def create_report(
    photo: UploadFile = File(...),
    type: str = Form(...),
    lat: float = Form(...),
    lng: float = Form(...),
    device_id: UUID = Form(...),
    live_photo: bool = Form(False),
    notes: str = Form("", max_length=500),
    ai_type: str | None = Form(None),
    ai_confidence: float | None = Form(None),
    ai_description: str | None = Form(None, max_length=300),
):
    if type not in REPORT_TYPES:
        raise HTTPException(400, f"Unknown report type: {type}")
    b = SJ_BOUNDS
    if not (b["min_lat"] <= lat <= b["max_lat"] and b["min_lng"] <= lng <= b["max_lng"]):
        raise HTTPException(400, "Reports must be in San Jose.")
    data = await read_photo(photo)
    photo_url = await save_photo(data, "image/jpeg")

    async with pool.connection() as conn:
        return await (await conn.execute(
            f"""insert into reports (type, notes, photo_url, reporter_id, live_photo,
                                     ai_type, ai_confidence, ai_description, geom)
                values (%s, %s, %s, %s, %s, %s, %s, %s,
                        st_setsrid(st_makepoint(%s, %s), 4326)::geography)
                returning {REPORT_COLUMNS}""",
            (type, notes.strip(), photo_url, device_id, live_photo,
             ai_type, ai_confidence, ai_description, lng, lat),
        )).fetchone()


class VerifyIn(BaseModel):
    device_id: UUID
    is_present: bool


@app.post("/api/reports/{report_id}/verify")
async def verify_report(report_id: UUID, body: VerifyIn):
    async with pool.connection() as conn:
        try:
            await conn.execute(
                "insert into verifications (report_id, device_id, is_present) values (%s, %s, %s)",
                (report_id, body.device_id, body.is_present),
            )
        except psycopg.errors.UniqueViolation:
            await conn.rollback()  # already answered; just return the current state
        except psycopg.errors.ForeignKeyViolation as err:
            raise HTTPException(404, "Report not found.") from err
        except psycopg.errors.RaiseException as err:
            raise HTTPException(403, err.diag.message_primary) from err
        row = await (await conn.execute(
            f"select {REPORT_COLUMNS} from reports where id = %s", (report_id,)
        )).fetchone()
    if not row:
        raise HTTPException(404, "Report not found.")
    return row


@app.delete("/api/reports/{report_id}", status_code=204)
async def delete_report(report_id: UUID, device_id: UUID):
    """Reporters can take back their own report. Everyone else uses verification."""
    async with pool.connection() as conn:
        cur = await conn.execute(
            "delete from reports where id = %s and reporter_id = %s", (report_id, device_id)
        )
        if cur.rowcount == 0:
            raise HTTPException(404, "No report of yours with that id.")
