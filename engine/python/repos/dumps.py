import sqlite3
from typing import List, Optional

from control_database import ControlDatabase
from .types import Dump


def _to_dump(row: sqlite3.Row) -> Dump:
    return Dump(
        id=row["id"],
        content=row["content"],
        created_at=row["created_at"],
    )


class DumpsRepository:
    """Read and write user-created dumps."""

    def __init__(self, database: ControlDatabase):
        self._database = database

    def create(self, content: str) -> Dump:
        cursor = self._database.connection.execute(
            "INSERT INTO dumps (content) VALUES (?)", (content,)
        )
        row = self._database.connection.execute(
            "SELECT id, content, created_at FROM dumps WHERE id = ?",
            (cursor.lastrowid,),
        ).fetchone()
        return _to_dump(row)

    def get_by_id(self, dump_id: int) -> Optional[Dump]:
        row = self._database.connection.execute(
            "SELECT id, content, created_at FROM dumps WHERE id = ?", (dump_id,)
        ).fetchone()
        return _to_dump(row) if row is not None else None

    def list_recent(self, limit: int = 50) -> List[Dump]:
        if limit < 1:
            raise ValueError("limit must be greater than zero")
        rows = self._database.connection.execute(
            "SELECT id, content, created_at FROM dumps "
            "ORDER BY created_at DESC, id DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [_to_dump(row) for row in rows]

    def clear_all(self) -> int:
        """Delete saved thoughts while preserving workers, reports, and memories."""
        with self._database.transaction():
            connection = self._database.connection
            count = connection.execute("SELECT COUNT(*) FROM dumps").fetchone()[0]
            if count == 0:
                return 0

            connection.execute(
                "DELETE FROM decisions WHERE dump_id IN (SELECT id FROM dumps)"
            )
            connection.execute(
                "DELETE FROM ai_jobs WHERE phase = 'judge' "
                "AND dump_id IN (SELECT id FROM dumps)"
            )
            connection.execute(
                "UPDATE ai_jobs SET dump_id = NULL "
                "WHERE dump_id IN (SELECT id FROM dumps)"
            )
            connection.execute(
                "UPDATE grandpa_memory SET source_dump_id = NULL "
                "WHERE source_dump_id IN (SELECT id FROM dumps)"
            )
            connection.execute("DELETE FROM dumps")
        return count
