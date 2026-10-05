import sqlite3
from typing import List, Optional

from control_database import ControlDatabase
from .types import GrandpaAction


def _to_grandpa_action(row: sqlite3.Row) -> GrandpaAction:
    return GrandpaAction(
        id=row["id"],
        report_id=row["report_id"],
        minipa_id=row["minipa_id"],
        decision=row["decision"],
        reason=row["reason"],
        decided_at=row["decided_at"],
    )


class GrandpaActionsRepository:
    """Store Grandpa's open-ended decisions about reports or MiniPas."""

    def __init__(self, database: ControlDatabase):
        self._database = database

    def create(
        self,
        decision: str,
        reason: str,
        report_id: Optional[int] = None,
        minipa_id: Optional[int] = None,
    ) -> GrandpaAction:
        cursor = self._database.connection.execute(
            "INSERT INTO grandpa_actions (report_id, minipa_id, decision, reason) "
            "VALUES (?, ?, ?, ?)",
            (report_id, minipa_id, decision, reason),
        )
        row = self._database.connection.execute(
            "SELECT id, report_id, minipa_id, decision, reason, decided_at "
            "FROM grandpa_actions WHERE id = ?",
            (cursor.lastrowid,),
        ).fetchone()
        return _to_grandpa_action(row)

    def list_for_minipa(self, minipa_id: int) -> List[GrandpaAction]:
        rows = self._database.connection.execute(
            "SELECT id, report_id, minipa_id, decision, reason, decided_at "
            "FROM grandpa_actions WHERE minipa_id = ? "
            "ORDER BY decided_at DESC, id DESC",
            (minipa_id,),
        ).fetchall()
        return [_to_grandpa_action(row) for row in rows]
