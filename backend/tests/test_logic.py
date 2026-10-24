from datetime import datetime, timedelta, timezone

from shapely import STRtree
from shapely.geometry import LineString, Point

from app.call_types import category_for
from app.report_types import confidence_from_votes, report_penalty
from app.scoring import summarize_lighting
from ingest.police_calls import normalize_address, parse_offense_at


def test_normalize_block_address_uses_middle_of_block():
    assert normalize_address("[3500]-[3600] ZANKER RD ") == "3550 ZANKER RD"
    assert normalize_address("[0]-[100] N 1ST ST") == "50 N 1ST ST"


def test_normalize_keeps_intersections_and_drops_blanks():
    assert normalize_address("N 1ST ST & E MISSION ST") == "N 1ST ST & E MISSION ST"
    assert normalize_address(None) is None
    assert normalize_address("   ") is None


def test_offense_time_is_san_jose_local():
    t = parse_offense_at("2026-10-21T00:00:00", "23:58:44")
    assert t.utcoffset() == timedelta(hours=-7)  # PDT
    assert (t.hour, t.minute) == (23, 58)


def test_call_type_categories():
    assert category_for("245") == "violent"
    assert category_for("245EMS") == "violent"
    assert category_for("415W") == "weapons"
    assert category_for("1195") is None  # vehicle stop: irrelevant to walking
    assert category_for(None) is None


def test_single_vote_does_not_create_certainty():
    assert confidence_from_votes(0, 0) == 0.5
    assert 0.5 < confidence_from_votes(1, 0) < 1


def test_report_penalty_decays_and_resolved_is_zero():
    now = datetime.now(timezone.utc)
    fresh = {"type": "lighting", "status": "verified", "confirm_count": 1, "deny_count": 0, "created_at": now}
    old = {**fresh, "created_at": now - timedelta(hours=168)}
    assert report_penalty(old, night=False, now=now) == report_penalty(fresh, night=False, now=now) / 2
    assert report_penalty(fresh, night=True, now=now) > report_penalty(fresh, night=False, now=now)
    assert report_penalty({**fresh, "status": "resolved"}, night=True, now=now) == 0


def test_lighting_finds_dark_stretch():
    # 300 m route in meters; lights only along the first 100 m.
    route = LineString([(500000, 4130000), (500300, 4130000)])
    lights = STRtree([Point(500000 + x, 4130010) for x in range(0, 101, 25)])
    s = summarize_lighting(route, lights)
    assert s["available"]
    assert 0.4 < s["coverage"] < 0.6
    assert 150 <= s["longest_dark_m"] <= 170
    assert len(s["dark_segments"]) == 1


def test_lighting_unavailable():
    s = summarize_lighting(LineString([(0, 0), (100, 0)]), None)
    assert not s["available"] and s["risk"] == 0


def test_night_hours():
    from app.scoring import is_night_hour
    assert is_night_hour(19) and is_night_hour(23) and is_night_hour(0) and is_night_hour(5)
    assert not is_night_hour(6) and not is_night_hour(12) and not is_night_hour(18)
