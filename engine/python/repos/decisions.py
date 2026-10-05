import sqlite3
from typing import List, Optional

from control_database import ControlDatabase
from .types import DecisionRecord, IntakeDecision, Verdict


def _to_decision(row: sqlite3.Row) -> DecisionRecord:
    return DecisionRecord(
        id=row["id"],
        dump_id=row["dump_id"],
        verdict=Verdict(row["verdict"]),
        reason=row["reason"],
        minipa_id=row["minipa_id"],
        decided_at=row["decided_at"],
    )


class DecisionsRepository:
    """Record Grandpa's verdict for a dump and its optional MiniPa."""

    def __init__(self, database: ControlDatabase):
        self._database = database

    def record(
        self,
        dump_id: int,
        decision: IntakeDecision,
        minipa_id: Optional[int] = None,
    ) -> DecisionRecord:
        cursor = self._database.connection.execute(
            "INSERT INTO decisions (dump_id, verdict, reason, minipa_id) "
            "VALUES (?, ?, ?, ?)",
            (dump_id, decision.verdict.value, decision.reason, minipa_id),
        )
        row = self._database.connection.execute(
            "SELECT id, dump_id, verdict, reason, minipa_id, decided_at "
            "FROM decisions WHERE id = ?",
            (cursor.lastrowid,),
        ).fetchone()
        return _to_decision(row)

    def list_for_dump(self, dump_id: int) -> List[DecisionRecord]:
        rows = self._database.connection.execute(
            "SELECT id, dump_id, verdict, reason, minipa_id, decided_at "
            "FROM decisions WHERE dump_id = ? ORDER BY decided_at DESC, id DESC",
            (dump_id,),
        ).fetchall()
        return [_to_decision(row) for row in rows]
