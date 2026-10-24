"""Community report types and how much each one penalizes a route.

Keep the keys identical to the check constraint in db/schema.sql and to
REPORT_TYPES in frontend/src/reportTypes.ts.

severity:        how much a fresh, verified report penalizes a route.
half_life_hours: how quickly a report's influence fades (exponential decay).
night_multiplier: extra weight when walking at night.
"""

import math
from datetime import datetime, timezone

REPORT_TYPES = {
    "obstruction":             {"label": "Obstruction",             "severity": 9.0, "half_life_hours": 24,  "night_multiplier": 1.0},
    "pedestrian_signal_issue": {"label": "Pedestrian signal issue", "severity": 7.0, "half_life_hours": 48,  "night_multiplier": 1.2},
    "construction":            {"label": "Construction",            "severity": 6.0, "half_life_hours": 48,  "night_multiplier": 1.0},
    "lighting":                {"label": "Lighting issue",          "severity": 6.0, "half_life_hours": 168, "night_multiplier": 1.8},
    "damaged_sidewalk":        {"label": "Damaged sidewalk",        "severity": 4.0, "half_life_hours": 336, "night_multiplier": 1.3},
    "unpaved_surface":         {"label": "Unpaved surface",         "severity": 3.0, "half_life_hours": 336, "night_multiplier": 1.0},
    "trash":                   {"label": "Trash / debris",          "severity": 2.0, "half_life_hours": 48,  "night_multiplier": 1.0},
    "other":                   {"label": "Other",                   "severity": 2.0, "half_life_hours": 48,  "night_multiplier": 1.0},
}


def confidence_from_votes(confirmations: int, denials: int) -> float:
    """Beta(1,1) estimate: a single vote never creates certainty."""
    return (1.0 + confirmations) / (2.0 + confirmations + denials)


def freshness(created_at: datetime, half_life_hours: float, now: datetime | None = None) -> float:
    """1.0 when new, 0.5 after half_life_hours, and so on."""
    now = now or datetime.now(timezone.utc)
    age_hours = max(0.0, (now - created_at).total_seconds() / 3600)
    return math.pow(2, -age_hours / half_life_hours)


def report_penalty(report: dict, night: bool, now: datetime | None = None) -> float:
    """penalty = severity × night multiplier × vote confidence × freshness"""
    t = REPORT_TYPES.get(report["type"])
    if not t or report["status"] == "resolved":
        return 0.0
    night_mul = t["night_multiplier"] if night else 1.0
    conf = confidence_from_votes(report["confirm_count"], report["deny_count"])
    return t["severity"] * night_mul * conf * freshness(report["created_at"], t["half_life_hours"], now)
