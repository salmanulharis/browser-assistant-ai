"""Backup & restore of all local data (SQLite + ChromaDB + uploaded documents).

Restore is only performed while the backend is stopped (scripts/backup.ps1 -Restore)
and always takes a safety backup of the current data first.
"""

from __future__ import annotations

import json
import shutil
import sqlite3
import tempfile
import zipfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from app.core.config import APP_VERSION, EnvSettings
from app.core.errors import AppError, NotFoundError
from app.security.sanitize import safe_join

MANIFEST = "lba-backup.json"


def _sqlite_snapshot(db_path: Path, dest: Path) -> None:
    """Consistent copy using SQLite's online backup API (safe while running)."""
    src = sqlite3.connect(str(db_path))
    try:
        dst = sqlite3.connect(str(dest))
        try:
            src.backup(dst)
        finally:
            dst.close()
    finally:
        src.close()


def create_backup(env: EnvSettings, label: str = "backup") -> Path:
    env.ensure_dirs()
    ts = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
    target = env.backups_dir / f"{label}-{ts}.zip"
    with tempfile.TemporaryDirectory() as tmp:
        snap = Path(tmp) / "app.db"
        if env.db_path.exists():
            _sqlite_snapshot(env.db_path, snap)
        with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            zf.writestr(MANIFEST, json.dumps({"app_version": APP_VERSION, "created_at": ts, "format": 1}))
            if snap.exists():
                zf.write(snap, "app.db")
            for folder, arc in ((env.chroma_dir, "chroma"), (env.documents_dir, "documents")):
                if folder.exists():
                    for f in folder.rglob("*"):
                        if f.is_file():
                            zf.write(f, f"{arc}/{f.relative_to(folder).as_posix()}")
    return target


def list_backups(env: EnvSettings) -> list[dict[str, Any]]:
    if not env.backups_dir.exists():
        return []
    out = []
    for f in sorted(env.backups_dir.glob("*.zip"), key=lambda p: p.stat().st_mtime, reverse=True):
        st = f.stat()
        out.append({"name": f.name, "size_bytes": st.st_size, "created_at": datetime.fromtimestamp(st.st_mtime, UTC)})
    return out


def backup_path(env: EnvSettings, name: str) -> Path:
    p = safe_join(env.backups_dir, name)
    if p.suffix != ".zip" or not p.exists():
        raise NotFoundError("Backup not found.")
    return p


def restore_backup(env: EnvSettings, archive: Path) -> Path:
    """Restore ``archive`` into the data dir. Returns the safety backup path.

    Must only be called while the backend is NOT running.
    """
    with zipfile.ZipFile(archive) as zf:
        names = zf.namelist()
        if MANIFEST not in names or "app.db" not in names:
            raise AppError("Not a Local Browser AI backup archive.", code="INVALID_BACKUP")
        for n in names:  # zip-slip protection
            safe_join(env.data_dir, n)
        safety = create_backup(env, label="pre-restore")
        staging = Path(tempfile.mkdtemp(prefix="lba-restore-"))
        try:
            zf.extractall(staging)
            for sub in ("chroma", "documents"):
                dest = env.data_dir / sub
                if dest.exists():
                    shutil.rmtree(dest)
                if (staging / sub).exists():
                    shutil.copytree(staging / sub, dest)
                else:
                    dest.mkdir(parents=True, exist_ok=True)
            for suffix in ("", "-wal", "-shm"):
                p = Path(str(env.db_path) + suffix)
                if p.exists():
                    p.unlink()
            shutil.copy2(staging / "app.db", env.db_path)
        finally:
            shutil.rmtree(staging, ignore_errors=True)
    return safety
