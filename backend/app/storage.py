"""Photo storage: Supabase Storage when configured, otherwise backend/uploads/."""

import secrets
import time

import httpx

from .config import settings


def using_supabase() -> bool:
    return bool(settings.supabase_url and settings.supabase_service_role_key)


async def save_photo(data: bytes, content_type: str = "image/jpeg") -> str:
    """Store the photo and return a URL the browser can load."""
    name = f"{int(time.time() * 1000)}-{secrets.token_hex(4)}.jpg"

    if using_supabase():
        bucket = settings.supabase_bucket
        async with httpx.AsyncClient(timeout=30) as client:
            res = await client.post(
                f"{settings.supabase_url}/storage/v1/object/{bucket}/{name}",
                content=data,
                headers={
                    "Authorization": f"Bearer {settings.supabase_service_role_key}",
                    "Content-Type": content_type,
                },
            )
        if res.status_code >= 300:
            raise RuntimeError(f"Supabase Storage upload failed ({res.status_code}): {res.text[:200]}")
        return f"{settings.supabase_url}/storage/v1/object/public/{bucket}/{name}"

    settings.uploads_dir.mkdir(parents=True, exist_ok=True)
    (settings.uploads_dir / name).write_bytes(data)
    return f"/uploads/{name}"
