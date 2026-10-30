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

    def clear_all(self) -> tuple[int, int]:
        """Delete MiniPas and their dependent execution and finding history."""
        connection = self._database.connection
        with self._database.transaction():
            minipa_ids = [row[0] for row in connection.execute("SELECT id FROM minipa")]
            if not minipa_ids:
                return 0, 0
            marks = ",".join("?" for _ in minipa_ids)
            report_ids = [row[0] for row in connection.execute(
                f"SELECT id FROM reports WHERE minipa_id IN ({marks})", minipa_ids
            )]
            reports_deleted = len(report_ids)
            if report_ids:
                report_marks = ",".join("?" for _ in report_ids)
                connection.execute(f"DELETE FROM hold_queue WHERE report_id IN ({report_marks})", report_ids)
                connection.execute(
                    f"DELETE FROM grandpa_actions WHERE minipa_id IN ({marks}) OR report_id IN ({report_marks})",
                    [*minipa_ids, *report_ids],
                )
            else:
                connection.execute(f"DELETE FROM grandpa_actions WHERE minipa_id IN ({marks})", minipa_ids)
            connection.execute(f"DELETE FROM decisions WHERE minipa_id IN ({marks})", minipa_ids)
            connection.execute(f"DELETE FROM ai_jobs WHERE minipa_id IN ({marks})", minipa_ids)
            connection.execute(f"DELETE FROM reports WHERE minipa_id IN ({marks})", minipa_ids)
            connection.execute(f"DELETE FROM minipa WHERE id IN ({marks})", minipa_ids)
            connection.execute("DELETE FROM seen_items")
        return len(minipa_ids), reports_deleted
