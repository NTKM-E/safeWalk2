"""Computer vision: suggest a report type from a photo using Google Gemini.

The model answers with JSON constrained to a schema, picking one of our report
types (or "none" when the photo shows no problem). The user can always change
the suggestion before saving.
"""

import base64
import json

import httpx

from .config import settings
from .report_types import REPORT_TYPES

GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models"

# What each type looks like, in words the model can match against the photo.
# "none" is only for the AI: it means "this photo shows no problem".
AI_TYPE_HINTS = {
    "obstruction":             "vehicles, fallen trees or large objects blocking the sidewalk or path",
    "pedestrian_signal_issue": "broken, dark or damaged traffic light or pedestrian crossing signal",
    "construction":            "construction work, cones, barriers, scaffolding, closed sidewalk",
    "lighting":                "broken or unlit streetlight, or a walkway that is clearly too dark",
    "damaged_sidewalk":        "cracked, broken, lifted or uneven sidewalk or pavement, potholes, trip hazards",
    "unpaved_surface":         "dirt, gravel or unpaved path where pavement is expected",
    "trash":                   "litter, trash bags, dumped items or debris on the path",
    "other":                   "a pedestrian infrastructure problem that fits none of the above",
    "none":                    "no infrastructure problem is visible, or the photo is unrelated",
}
assert set(AI_TYPE_HINTS) - {"none"} == set(REPORT_TYPES), "AI_TYPE_HINTS must match REPORT_TYPES"

PROMPT = f"""You review photos submitted to a pedestrian safety app.
Classify the main pedestrian or road infrastructure problem visible in the photo.
Types:
{chr(10).join(f"- {key}: {hint}" for key, hint in AI_TYPE_HINTS.items())}
Only describe what is visible. Do not guess about people, crime, or intent.
Give a conservative confidence from 0 to 1 and a one-sentence description."""

# Gemini's structured-output schema: forces the reply into this exact shape.
SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "type":        {"type": "STRING", "enum": list(AI_TYPE_HINTS)},
        "confidence":  {"type": "NUMBER"},
        "description": {"type": "STRING"},
    },
    "required": ["type", "confidence", "description"],
}


def vision_enabled() -> bool:
    return bool(settings.gemini_api_key)


class VisionError(Exception):
    pass


async def classify_image(image: bytes, media_type: str = "image/jpeg") -> dict:
    """Returns {type, confidence, description}; type is one of AI_TYPE_HINTS' keys."""
    if not vision_enabled():
        raise VisionError("Set GEMINI_API_KEY in backend/.env to enable AI suggestions.")

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            res = await client.post(
                f"{GEMINI_URL}/{settings.gemini_model}:generateContent",
                headers={"x-goog-api-key": settings.gemini_api_key},
                json={
                    "contents": [{"parts": [
                        {"text": PROMPT},
                        {"inline_data": {
                            "mime_type": media_type,
                            "data": base64.standard_b64encode(image).decode("utf-8"),
                        }},
                    ]}],
                    "generationConfig": {
                        "responseMimeType": "application/json",
                        "responseSchema": SCHEMA,
                        "temperature": 0,
                    },
                },
            )
    except httpx.HTTPError as err:
        raise VisionError("Couldn't reach the Gemini API.") from err

    if res.status_code == 429:
        raise VisionError("AI is busy right now (rate limited). Pick the type yourself.")
    if res.status_code >= 400:
        raise VisionError(f"Gemini returned HTTP {res.status_code}: {res.text[:200]}")

    # The JSON answer comes back as text inside the first candidate.
    parts = (res.json().get("candidates") or [{}])[0].get("content", {}).get("parts", [])
    text = "".join(p.get("text", "") for p in parts if not p.get("thought"))
    if not text:
        raise VisionError("Gemini gave no answer (the image may have been blocked).")
    try:
        result = json.loads(text)
    except json.JSONDecodeError as err:
        raise VisionError("Gemini's answer wasn't valid JSON.") from err

    # Never trust the reply blindly: clamp it back into our allowed values.
    return {
        "type": result.get("type") if result.get("type") in AI_TYPE_HINTS else "other",
        "confidence": max(0.0, min(1.0, float(result.get("confidence") or 0))),
        "description": str(result.get("description") or "")[:300],
    }
