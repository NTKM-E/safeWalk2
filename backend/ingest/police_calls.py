"""Ingest San Jose Police Calls for Service into Postgres.

    cd backend && python -m ingest.police_calls              # last 30 days, max 2000 rows
    python -m ingest.police_calls --days 90 --limit 20000     # bigger pull
    python -m ingest.police_calls --dry-run                   # fetch + geocode, don't write calls

Instead of downloading each year's full CSV (~1M rows), this asks the city's
CKAN Data API for just the pedestrian-relevant call types in a recent window.
New block-level addresses are geocoded with the city's own locator (which also
handles "X ST & Y ST" intersections) and cached, so nightly runs only geocode
the handful of addresses they haven't seen. Safe to re-run: rows are upserted.
"""

import argparse
import json
import re
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import httpx
import psycopg

from app.call_types import all_codes, category_for
from app.config import settings

CKAN = "https://data.sanjoseca.gov/api/3/action"
PACKAGE = "police-calls-for-service"
GEOCODER = "https://geo.sanjoseca.gov/server/rest/services/Locators/DPW_CSJLocator/GeocodeServer/geocodeAddresses"
PAGE_SIZE = 1000
GEOCODE_BATCH = 500
MIN_GEOCODE_SCORE = 80
SAN_JOSE_TZ = ZoneInfo("America/Los_Angeles")

BLOCK_RE = re.compile(r"^\[(\d+)\]-\[(\d+)\]\s+(.+)$")


def normalize_address(raw: str | None) -> str | None:
    """'[3500]-[3600] ZANKER RD ' -> '3550 ZANKER RD' (middle of the block).
    Intersections like 'N 1ST ST & E MISSION ST' pass through unchanged."""
    if not raw or not raw.strip():
        return None
    addr = " ".join(raw.split()).upper()
    m = BLOCK_RE.match(addr)
    if m:
        return f"{int(m.group(1)) + 50} {m.group(3)}"
    return addr


def parse_offense_at(offense_date: str, offense_time: str | None) -> datetime:
    day = datetime.fromisoformat(offense_date).date()
    t = datetime.strptime((offense_time or "00:00:00").strip()[:8], "%H:%M:%S").time()
    return datetime.combine(day, t, tzinfo=SAN_JOSE_TZ)


# ---------- Fetch from the city's open data portal ----------
def year_resources(client: httpx.Client) -> dict[int, str]:
    """{year: resource_id} for the yearly 'Police Calls YYYY' files."""
    res = client.get(f"{CKAN}/package_show", params={"id": PACKAGE})
    res.raise_for_status()
    out = {}
    for r in res.json()["result"]["resources"]:
        m = re.fullmatch(r"Police Calls (\d{4})", r["name"].strip())
        if m and r.get("datastore_active"):
            out[int(m.group(1))] = r["id"]
    return out


def fetch_calls(client: httpx.Client, resource_id: str, since: date, limit: int) -> list[dict]:
    codes = ",".join(f"'{c}'" for c in all_codes())  # fixed list from our code, not user input
    rows: list[dict] = []
    while len(rows) < limit:
        page = min(PAGE_SIZE, limit - len(rows))
        sql = (
            f'SELECT "CALL_NUMBER","CALLTYPE_CODE","CALL_TYPE","PRIORITY","OFFENSE_DATE",'
            f'"OFFENSE_TIME","ADDRESS","FINAL_DISPO" FROM "{resource_id}" '
            f'WHERE "CALLTYPE_CODE" IN ({codes}) AND "OFFENSE_DATE" >= \'{since.isoformat()}\' '
            f'ORDER BY "_id" DESC LIMIT {page} OFFSET {len(rows)}'
        )
        res = client.get(f"{CKAN}/datastore_search_sql", params={"sql": sql})
        res.raise_for_status()
        body = res.json()
        if not body.get("success"):
            raise RuntimeError(f"CKAN query failed: {body.get('error')}")
        batch = body["result"]["records"]
        rows.extend(batch)
        if len(batch) < page:
            break
    return rows


# ---------- Geocode with the City of San Jose locator ----------
def geocode_batch(client: httpx.Client, addresses: list[str]) -> dict[str, dict]:
    records = [{"attributes": {"OBJECTID": i, "SingleLine": a}} for i, a in enumerate(addresses)]
    res = client.post(GEOCODER, data={
        "addresses": json.dumps({"records": records}),
        "outSR": 4326,
        "f": "json",
    })
    res.raise_for_status()
    body = res.json()
    if "error" in body:
        raise RuntimeError(f"Geocoder error: {body['error']}")
    out = {}
    for loc in body.get("locations", []):
        a = loc["attributes"]
        addr = addresses[a["ResultID"]]
        good = a.get("Score", 0) >= MIN_GEOCODE_SCORE and loc.get("location")
        out[addr] = {
            "lat": loc["location"]["y"] if good else None,
            "lng": loc["location"]["x"] if good else None,
            "score": a.get("Score"),
            "addr_type": a.get("Addr_type"),
        }
    return out


def retry_block_ends(client: httpx.Client, results: dict[str, dict]) -> None:
    """The locator sometimes can't place the middle of a block ('1150 LUNDY AV') but
    can place its ends ('1199 LUNDY AV'). Retry failed block addresses with both ends."""
    variants: dict[str, str] = {}  # variant -> original
    for addr, r in results.items():
        m = re.match(r"^(\d*)50 (.+)$", addr)
        if r["lat"] is None and m:
            block = int(m.group(1) or 0) * 100
            variants.setdefault(f"{block + 99} {m.group(2)}", addr)
            if block:
                variants.setdefault(f"{block} {m.group(2)}", addr)
    if not variants:
        return
    for variant, r in geocode_batch(client, list(variants)).items():
        original = variants[variant]
        if r["lat"] is not None and results[original]["lat"] is None:
            results[original] = r


def geocode_new(conn: psycopg.Connection, client: httpx.Client, addresses: set[str]) -> None:
    known = {r[0] for r in conn.execute(
        "select address from geocode_cache where address = any(%s)", (list(addresses),)
    )}
    todo = sorted(addresses - known)
    print(f"Geocoding {len(todo)} new addresses ({len(known)} already cached)")
    for i in range(0, len(todo), GEOCODE_BATCH):
        chunk = todo[i:i + GEOCODE_BATCH]
        results = geocode_batch(client, chunk)
        retry_block_ends(client, results)
        with conn.cursor() as cur:
            cur.executemany(
                """insert into geocode_cache (address, lat, lng, score, addr_type)
                   values (%s, %s, %s, %s, %s)
                   on conflict (address) do update set lat = excluded.lat, lng = excluded.lng,
                     score = excluded.score, addr_type = excluded.addr_type, geocoded_at = now()""",
                [(a, *(results.get(a, {}).get(k) for k in ("lat", "lng", "score", "addr_type"))) for a in chunk],
            )
        conn.commit()
        print(f"  {min(i + GEOCODE_BATCH, len(todo))}/{len(todo)}")


# ---------- Main ----------
def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--days", type=int, default=30, help="how far back to fetch (default 30)")
    parser.add_argument("--limit", type=int, default=2000, help="max rows to fetch in total (default 2000)")
    parser.add_argument("--dry-run", action="store_true", help="don't write police calls to the database")
    args = parser.parse_args()

    since = date.today() - timedelta(days=args.days)
    with httpx.Client(timeout=120) as client, psycopg.connect(settings.database_url) as conn:
        resources = year_resources(client)
        rows: list[dict] = []
        # Newest year first, so --limit keeps the most recent calls.
        for year in range(date.today().year, since.year - 1, -1):
            if year not in resources:
                print(f"No datastore resource for {year}; skipping")
                continue
            remaining = args.limit - len(rows)
            if remaining <= 0:
                break
            batch = fetch_calls(client, resources[year], since, remaining)
            print(f"{year}: fetched {len(batch)} calls since {since}")
            rows.extend(batch)

        calls = []
        for r in rows:
            category = category_for(r["CALLTYPE_CODE"])
            if not category or not r.get("OFFENSE_DATE"):
                continue
            calls.append({
                "call_number": r["CALL_NUMBER"],
                "call_type_code": r["CALLTYPE_CODE"].strip(),
                "call_type": (r["CALL_TYPE"] or "").strip(),
                "category": category,
                "priority": int(r["PRIORITY"]) if r.get("PRIORITY") is not None else None,
                "offense_at": parse_offense_at(r["OFFENSE_DATE"], r.get("OFFENSE_TIME")),
                "address": normalize_address(r.get("ADDRESS")),
                "final_dispo": r.get("FINAL_DISPO"),
            })

        geocode_new(conn, client, {c["address"] for c in calls if c["address"]})

        if args.dry_run:
            print(f"Dry run: would upsert {len(calls)} calls")
            return
        with conn.cursor() as cur:
            cur.executemany(
                """insert into police_calls (call_number, call_type_code, call_type, category, priority,
                                             offense_at, address, final_dispo, geom)
                   select %(call_number)s, %(call_type_code)s, %(call_type)s, %(category)s, %(priority)s,
                          %(offense_at)s, %(address)s, %(final_dispo)s,
                          (select st_setsrid(st_makepoint(g.lng, g.lat), 4326)::geography
                           from geocode_cache g where g.address = %(address)s and g.lat is not null)
                   on conflict (call_number) do update set
                     call_type = excluded.call_type, category = excluded.category,
                     priority = excluded.priority, final_dispo = excluded.final_dispo,
                     address = excluded.address, geom = excluded.geom, ingested_at = now()""",
                calls,
            )
        conn.commit()
        located = conn.execute(
            "select count(*) from police_calls where call_number = any(%s) and geom is not null",
            ([c["call_number"] for c in calls],),
        ).fetchone()[0]
        print(f"Upserted {len(calls)} calls ({located} with a location)")


if __name__ == "__main__":
    main()
