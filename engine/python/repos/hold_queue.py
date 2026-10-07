import sqlite3
from typing import List, Optional

from control_database import ControlDatabase
from .types import HeldItem, HoldStatus


def _to_held_item(row: sqlite3.Row) -> HeldItem:
    return HeldItem(
        id=row["id"],
        report_id=row["report_id"],
        status=HoldStatus(row["status"]),
        created_at=row["created_at"],
        expires_at=row["expires_at"],
        surfaced_at=row["surfaced_at"],
    )


class HoldQueueRepository:
    """Store and update reports waiting for a user-facing decision."""

    def __init__(self, database: ControlDatabase):
        self._database = database

    def create(self, report_id: int, expires_at: Optional[str] = None) -> HeldItem:
        cursor = self._database.connection.execute(
            "INSERT INTO hold_queue (report_id, expires_at) VALUES (?, ?)", (report_id, expires_at)
        )
        row = self._database.connection.execute(
            "SELECT id, report_id, status, created_at, expires_at, surfaced_at "
            "FROM hold_queue WHERE id = ?",
            (cursor.lastrowid,),
        ).fetchone()
        return _to_held_item(row)

    def get_by_report_id(self, report_id: int) -> Optional[HeldItem]:
        row = self._database.connection.execute(
            "SELECT id, report_id, status, created_at, expires_at, surfaced_at "
            "FROM hold_queue WHERE report_id = ?",
            (report_id,),
        ).fetchone()
        return _to_held_item(row) if row is not None else None

    def get_by_id(self, item_id: int) -> Optional[HeldItem]:
        row = self._database.connection.execute(
            "SELECT id, report_id, status, created_at, expires_at, surfaced_at "
            "FROM hold_queue WHERE id = ?",
            (item_id,),
        ).fetchone()
        return _to_held_item(row) if row is not None else None

    def list_held(self, limit: int = 100) -> List[HeldItem]:
        if limit < 1:
            raise ValueError("limit must be greater than zero")
        rows = self._database.connection.execute(
            "SELECT id, report_id, status, created_at, expires_at, surfaced_at "
            "FROM hold_queue WHERE status = 'held' "
            "ORDER BY created_at ASC, id ASC LIMIT ?",
            (limit,),
        ).fetchall()
        return [_to_held_item(row) for row in rows]

    def count_held(self) -> int:
        row = self._database.connection.execute(
            "SELECT COUNT(*) AS count FROM hold_queue WHERE status = 'held'"
        ).fetchone()
        return int(row["count"])

    def expire_due(self) -> int:
        cursor = self._database.connection.execute(
            "UPDATE hold_queue SET status = 'expired' "
            "WHERE status = 'held' AND expires_at IS NOT NULL "
            "AND expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"
        )
        return cursor.rowcount

    def update_status(self, item_id: int, status: HoldStatus) -> bool:
        if status == HoldStatus.SURFACED:
            cursor = self._database.connection.execute(
                "UPDATE hold_queue SET status = ?, "
                "surfaced_at = COALESCE(surfaced_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) "
                "WHERE id = ? AND status = 'held'",
                (status.value, item_id),
            )
        else:
            cursor = self._database.connection.execute(
                "UPDATE hold_queue SET status = ? WHERE id = ? AND status = 'held'",
                (status.value, item_id),
            )
        return cursor.rowcount > 0
