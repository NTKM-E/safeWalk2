import asyncio
import json
from dataclasses import replace

import httpx

from app import vision

REAL_CLIENT = httpx.AsyncClient


def run_classify(monkeypatch, reply: dict, status: int = 200) -> tuple[dict | Exception, httpx.Request]:
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["request"] = request
        return httpx.Response(status, json=reply)

    monkeypatch.setattr(vision, "settings", replace(vision.settings, gemini_api_key="test-key"))
    monkeypatch.setattr(vision.httpx, "AsyncClient",
                        lambda **kw: REAL_CLIENT(transport=httpx.MockTransport(handler), **kw))
    try:
        result = asyncio.run(vision.classify_image(b"\xff\xd8fake"))
    except vision.VisionError as err:
        result = err
    return result, seen["request"]


def gemini_reply(answer: dict) -> dict:
    return {"candidates": [{"content": {"parts": [{"text": json.dumps(answer)}]}}]}


def test_sends_key_header_and_schema(monkeypatch):
    result, request = run_classify(monkeypatch, gemini_reply(
        {"type": "lighting", "confidence": 0.9, "description": "Unlit streetlight."}))
    assert result == {"type": "lighting", "confidence": 0.9, "description": "Unlit streetlight."}
    assert request.headers["x-goog-api-key"] == "test-key"
    assert request.url.path.endswith(f"/{vision.settings.gemini_model}:generateContent")
    body = json.loads(request.content)
    assert body["generationConfig"]["responseSchema"]["properties"]["type"]["enum"][-1] == "none"
    assert body["contents"][0]["parts"][1]["inline_data"]["mime_type"] == "image/jpeg"


def test_clamps_bad_values(monkeypatch):
    result, _ = run_classify(monkeypatch, gemini_reply(
        {"type": "alien", "confidence": 7, "description": "x" * 500}))
    assert result["type"] == "other" and result["confidence"] == 1.0 and len(result["description"]) == 300


def test_errors_become_vision_errors(monkeypatch):
    result, _ = run_classify(monkeypatch, {"error": "quota"}, status=429)
    assert isinstance(result, vision.VisionError) and "rate limited" in str(result)
    result, _ = run_classify(monkeypatch, {"candidates": []})
    assert isinstance(result, vision.VisionError)
