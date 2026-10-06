from control_database import ControlDatabase


class AttentionRepository:
    def __init__(self, database: ControlDatabase):
        self._database = database

    def preferences(self) -> dict[str, bool]:
        row = self._database.connection.execute(
            'SELECT focus_enabled, auto_surface_enabled FROM attention_preferences WHERE id = 1'
        ).fetchone()
        return {key: bool(row[key]) for key in row.keys()}

    def update_preferences(self, focus_enabled: bool, auto_surface_enabled: bool) -> None:
        self._database.connection.execute(
            'UPDATE attention_preferences SET focus_enabled=?, auto_surface_enabled=? WHERE id=1',
            (int(focus_enabled), int(auto_surface_enabled)),
        )

    def surfaced_reports(self) -> list[dict]:
        rows = self._database.connection.execute(
            "SELECT h.id AS hold_id, r.id AS report_id, r.minipa_id, r.content, h.surfaced_at "
            "FROM hold_queue h JOIN reports r ON r.id=h.report_id WHERE h.status='surfaced' "
            'ORDER BY h.surfaced_at DESC, h.id DESC LIMIT 100'
        ).fetchall()
        return [dict(row) for row in rows]
