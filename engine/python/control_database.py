from pathlib import Path
import sqlite3


class ControlDatabase:
    def __init__(self, database_path: Path, migrations_dir: Path):
        database_path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(database_path, timeout=5)
        self.connection.row_factory = sqlite3.Row
        self.connection.execute("PRAGMA foreign_keys = ON")
        self.connection.execute("PRAGMA busy_timeout = 5000")
        self.connection.execute("PRAGMA journal_mode = WAL")
        try:
            self._apply_migrations(migrations_dir)
            self._close_interrupted_activity()
        except Exception:
            self.connection.close()
            raise
    def _apply_migrations(self, migrations_dir: Path) -> None:
        version = self.connection.execute("PRAGMA user_version").fetchone()[0]
        migration_files = sorted(migrations_dir.glob("*.sql"))
        migrations = []
        for migration in migration_files:
            try:
                migration_version = int(migration.name.split("_", 1)[0])
            except ValueError as error:
                raise RuntimeError(
                    f"Migration filename must start with a number: {migration.name}"
                ) from error
            migrations.append((migration_version, migration))

        latest_version = max((number for number, _ in migrations), default=0)
        if version > latest_version:
            raise RuntimeError(
                f"Database schema version {version} is newer than this app supports"
            )

        for migration_version, migration in migrations:
            if migration_version <= version:
                continue
            if migration_version != version + 1:
                raise RuntimeError(
                    f"Expected migration {version + 1:04d}, found {migration.name}"
                )
            sql = migration.read_text(encoding="utf-8")
            self.connection.executescript(
                "BEGIN IMMEDIATE;\n"
                + sql
                + f"\nPRAGMA user_version = {migration_version};\nCOMMIT;"
            )
            version = migration_version

    def record_activity(self, category: str) -> None:
        with self.connection:
            active = self.connection.execute(
                "SELECT category FROM user_activity WHERE end_time IS NULL "
                "ORDER BY id DESC LIMIT 1"
            ).fetchone()
            if active is not None and active["category"] == category:
                return

            self.connection.execute(
                "UPDATE user_activity "
                "SET end_time = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') "
                "WHERE end_time IS NULL"
            )
            self.connection.execute(
                "INSERT INTO user_activity (category) VALUES (?)", (category,)
            )

    def _close_interrupted_activity(self) -> None:
        with self.connection:
            self.connection.execute(
                "UPDATE user_activity "
                "SET end_time = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') "
                "WHERE end_time IS NULL"
            )

    def close_activity(self) -> None:
        with self.connection:
            self.connection.execute(
                "UPDATE user_activity "
                "SET end_time = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') "
                "WHERE end_time IS NULL"
            )

    def close(self) -> None:
        self.connection.close()
