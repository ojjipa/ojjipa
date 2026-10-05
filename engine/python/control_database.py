from contextlib import contextmanager
from pathlib import Path
import sqlite3
from threading import Lock, local
from typing import Iterator


class ControlDatabase:
    def __init__(self, database_path: Path, migrations_dir: Path):
        database_path.parent.mkdir(parents=True, exist_ok=True)
        self._database_path = database_path
        self._thread_state = local()
        self._connections_lock = Lock()
        self._connections: list[sqlite3.Connection] = []
        self._closed = False
        try:
            connection = self.connection
            connection.execute("PRAGMA journal_mode = WAL")
            self._apply_migrations(migrations_dir)
        except Exception:
            self.close()
            raise

    @property
    def connection(self) -> sqlite3.Connection:
        """Return a connection owned by the calling thread.

        A ControlDatabase can safely be shared between worker threads. Each
        thread gets a separate SQLite connection, so transactions and reads
        cannot leak across threads through a shared connection object.
        """
        if self._closed:
            raise RuntimeError("database is closed")
        connection = getattr(self._thread_state, "connection", None)
        if connection is not None:
            return connection

        with self._connections_lock:
            if self._closed:
                raise RuntimeError("database is closed")
            # isolation_level=None leaves transaction ownership explicit.
            # check_same_thread=False is only needed so close() can clean up
            # worker-owned connections after those workers have stopped.
            connection = sqlite3.connect(
                self._database_path,
                timeout=5,
                isolation_level=None,
                check_same_thread=False,
            )
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA foreign_keys = ON")
            connection.execute("PRAGMA busy_timeout = 5000")
            self._thread_state.connection = connection
            self._connections.append(connection)
            return connection

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

    @contextmanager
    def transaction(self) -> Iterator[None]:
        connection = self.connection
        if connection.in_transaction:
            raise RuntimeError("Nested database transactions are not supported")
        connection.execute("BEGIN IMMEDIATE")
        try:
            yield
        except BaseException:
            connection.rollback()
            raise
        else:
            connection.commit()

    def close(self) -> None:
        with self._connections_lock:
            if self._closed:
                return
            self._closed = True
            connections = self._connections
            self._connections = []
        for connection in connections:
            connection.close()
