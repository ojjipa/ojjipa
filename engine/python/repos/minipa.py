import sqlite3
from typing import List, Optional
from control_database import ControlDatabase
from .types import Minipa, MinipaKind, MinipaStatus
def _to_minipa(row: sqlite3.Row) -> Minipa:
    return Minipa(
        id=row["id"],
        kind=MinipaKind(row["kind"]),
        purpose=row["purpose"],
        source=row["source"],
        termination_condition=row["termination_condition"],
        scope=row["scope"],
        config=row["config"],
        status=MinipaStatus(row["status"]),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )

class MiniPaRepository:
    """Create MiniPas and read or change their lifecycle status."""

    def __init__(self, database: ControlDatabase):
        self._database = database

    def create(
        self,
        kind: MinipaKind,
        purpose: str,
        source: Optional[str] = None,
        termination_condition: Optional[str] = None,
        scope: str = "global",
        config: str = "{}",
    ) -> Minipa:
        cursor = self._database.connection.execute(
            "INSERT INTO minipa "
            "(kind, purpose, source, termination_condition, scope, config) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (kind.value, purpose, source, termination_condition, scope, config),
        )
        minipa = self.get_by_id(int(cursor.lastrowid))
        assert minipa is not None
        return minipa

    def get_by_id(self, minipa_id: int) -> Optional[Minipa]:
        row = self._database.connection.execute(
            "SELECT id, kind, purpose, source, termination_condition, scope, config, "
            "status, created_at, updated_at FROM minipa WHERE id = ?",
            (minipa_id,),
        ).fetchone()
        return _to_minipa(row) if row is not None else None

    def list_active(self) -> List[Minipa]:
        rows = self._database.connection.execute(
            "SELECT id, kind, purpose, source, termination_condition, scope, config, "
            "status, created_at, updated_at FROM minipa "
            "WHERE status = 'active' ORDER BY created_at DESC, id DESC"
        ).fetchall()
        return [_to_minipa(row) for row in rows]

    def update_status(self, minipa_id: int, status: MinipaStatus) -> bool:
        cursor = self._database.connection.execute(
            "UPDATE minipa SET status = ? WHERE id = ?", (status.value, minipa_id)
        )
        return cursor.rowcount > 0
