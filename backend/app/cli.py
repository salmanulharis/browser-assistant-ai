"""Command line helpers used by the PowerShell scripts.

    python -m app.cli init              create dirs, token, migrate DB
    python -m app.cli token             print the API token
    python -m app.cli paths             print data paths as JSON
    python -m app.cli backup            create a backup zip
    python -m app.cli restore <zip>     restore (backend must be stopped)
    python -m app.cli check             quick offline environment check (JSON)
"""

from __future__ import annotations

import json
import sys
from pathlib import Path


def main(argv: list[str]) -> int:
    from app.core.config import get_env
    from app.database.base import Database
    from app.database.migrations import current_version, migrate
    from app.security.auth import load_or_create_token
    from app.services.backup import create_backup, restore_backup

    env = get_env()
    cmd = argv[0] if argv else "help"
    if cmd == "init":
        env.ensure_dirs()
        load_or_create_token(env.token_path)
        db = Database(env.db_path)
        applied = migrate(db)
        db.dispose()
        print(json.dumps({"data_dir": str(env.data_dir), "migrations_applied": applied}))
        return 0
    if cmd == "token":
        env.ensure_dirs()
        print(load_or_create_token(env.token_path))
        return 0
    if cmd == "paths":
        print(json.dumps({k: str(getattr(env, k)) for k in ("data_dir", "db_path", "chroma_dir", "documents_dir", "backups_dir", "logs_dir", "token_path")}))
        return 0
    if cmd == "backup":
        print(create_backup(env))
        return 0
    if cmd == "restore":
        if len(argv) < 2:
            print("usage: restore <backup.zip>", file=sys.stderr)
            return 2
        safety = restore_backup(env, Path(argv[1]))
        print(json.dumps({"restored": argv[1], "safety_backup": str(safety)}))
        return 0
    if cmd == "check":
        out: dict[str, object] = {"python": sys.version.split()[0], "data_dir": str(env.data_dir),
                                  "token_exists": env.token_path.exists(), "db_exists": env.db_path.exists(),
                                  "allowed_origins": env.origins}
        if env.db_path.exists():
            db = Database(env.db_path)
            out["schema_version"] = current_version(db)
            db.dispose()
        print(json.dumps(out))
        return 0
    print(__doc__)
    return 0 if cmd == "help" else 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
