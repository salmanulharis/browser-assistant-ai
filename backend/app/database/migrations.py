"""Versioned schema migrations.

Each migration is an ordered, idempotent function applied inside a transaction
and recorded in ``schema_migrations``. Add new migrations to ``MIGRATIONS`` –
never edit an applied one.
"""

from __future__ import annotations

import logging
from collections.abc import Callable

from sqlalchemy import Connection, text

from app.database.base import Base, Database

log = logging.getLogger(__name__)

DEFAULT_CATEGORIES: list[tuple[str, str, bool]] = [
    ("profile", "Professional background and bio", True),
    ("skills", "Skills and technologies", True),
    ("projects", "Projects and work samples", True),
    ("preferences", "Personal preferences", True),
    ("writing_style", "Preferred tone and writing style", True),
    ("contact", "Contact details the user chose to save", False),
    ("other", "Uncategorised", False),
]


def _m001_initial(conn: Connection) -> None:
    import app.models.entities  # noqa: F401  (register tables)

    Base.metadata.create_all(conn)
    for name, desc, auto in DEFAULT_CATEGORIES:
        conn.execute(
            text(
                "INSERT OR IGNORE INTO memory_categories (name, description, auto_allowed, created_at) "
                "VALUES (:n, :d, :a, CURRENT_TIMESTAMP)"
            ),
            {"n": name, "d": desc, "a": auto},
        )


def _m002_search_indexes(conn: Connection) -> None:
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_prompts_pinned ON prompts (pinned)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_memories_pinned ON memories (pinned)"))
    conn.execute(
        text("CREATE INDEX IF NOT EXISTS ix_conversations_updated ON conversations (updated_at)")
    )


MIGRATIONS: list[tuple[int, str, Callable[[Connection], None]]] = [
    (1, "initial schema", _m001_initial),
    (2, "search indexes", _m002_search_indexes),
]


def current_version(db: Database) -> int:
    with db.engine.begin() as conn:
        conn.execute(
            text(
                "CREATE TABLE IF NOT EXISTS schema_migrations ("
                "version INTEGER PRIMARY KEY, name TEXT NOT NULL, "
                "applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)"
            )
        )
        row = conn.execute(text("SELECT MAX(version) FROM schema_migrations")).scalar()
        return int(row or 0)


def migrate(db: Database) -> list[int]:
    applied: list[int] = []
    version = current_version(db)
    for num, name, fn in MIGRATIONS:
        if num <= version:
            continue
        with db.engine.begin() as conn:
            log.info("Applying migration %03d: %s", num, name)
            fn(conn)
            conn.execute(
                text("INSERT INTO schema_migrations (version, name) VALUES (:v, :n)"),
                {"v": num, "n": name},
            )
        applied.append(num)
    return applied


def latest_version() -> int:
    return MIGRATIONS[-1][0]
