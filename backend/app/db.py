"""Postgres connection pool shared by the API."""

from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from .config import settings

pool = AsyncConnectionPool(
    settings.database_url,
    min_size=1,
    max_size=10,
    open=False,
    # prepare_threshold=None: Supabase's transaction pooler doesn't support prepared statements.
    kwargs={"row_factory": dict_row, "prepare_threshold": None},
)
