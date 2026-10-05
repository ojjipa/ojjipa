import sqlite3
from typing import List, Optional

from control_database import ControlDatabase
from .types import Report


def _to_report(row: sqlite3.Row) -> Report:
    return Report(
        id=row["id"],
        minipa_id=row["minipa_id"],
        content=row["content"],
        created_at=row["created_at"],
    )


class ReportsRepository:
    """Store reports produced by MiniPas."""

    def __init__(self, database: ControlDatabase):
        self._database = database

    def create(self, minipa_id: int, content: str) -> Report:
        cursor = self._database.connection.execute(
            "INSERT INTO reports (minipa_id, content) VALUES (?, ?)",
            (minipa_id, content),
        )
        row = self._database.connection.execute(
            "SELECT id, minipa_id, content, created_at FROM reports WHERE id = ?",
            (cursor.lastrowid,),
        ).fetchone()
        return _to_report(row)

    def get_by_id(self, report_id: int) -> Optional[Report]:
        row = self._database.connection.execute(
            "SELECT id, minipa_id, content, created_at FROM reports WHERE id = ?",
            (report_id,),
        ).fetchone()
        return _to_report(row) if row is not None else None

    def list_for_minipa(self, minipa_id: int) -> List[Report]:
        rows = self._database.connection.execute(
            "SELECT id, minipa_id, content, created_at FROM reports "
            "WHERE minipa_id = ? ORDER BY created_at DESC, id DESC",
            (minipa_id,),
        ).fetchall()
        return [_to_report(row) for row in rows]
