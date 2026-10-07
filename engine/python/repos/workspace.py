"""Read persisted workspace data for the desktop UI."""
from dataclasses import asdict
from repos.dumps import DumpsRepository


class WorkspaceRepository:
    def __init__(self, database):
        self.database = database

    def snapshot(self):
        connection = self.database.connection
        return {
            'thoughts': [asdict(item) for item in DumpsRepository(self.database).list_recent(100)],
            'minipas': [dict(row) for row in connection.execute(
                'SELECT id, kind, purpose, status, termination_condition FROM minipa ORDER BY id DESC LIMIT 100')],
            'reports': [dict(row) for row in connection.execute(
                'SELECT r.id, r.minipa_id, r.content, r.created_at, h.id AS hold_id, h.status AS delivery '
                'FROM reports r LEFT JOIN hold_queue h ON h.report_id=r.id ORDER BY r.id DESC LIMIT 100')],
        }
