from control_database import ControlDatabase


class ActivityRepository:
    """Record category intervals detected by the desktop app."""

    def __init__(self, database: ControlDatabase):
        self._database = database

    def recover_open_interval(self) -> None:
        self._database.connection.execute(
            "UPDATE user_activity "
            "SET end_time = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') "
            "WHERE end_time IS NULL"
        )

    def record_category(self, category: str) -> None:
        active = self._database.connection.execute(
            "SELECT category FROM user_activity WHERE end_time IS NULL "
            "ORDER BY id DESC LIMIT 1"
        ).fetchone()
        if active is not None and active["category"] == category:
            return

        self._database.connection.execute(
            "UPDATE user_activity "
            "SET end_time = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') "
            "WHERE end_time IS NULL"
        )
        self._database.connection.execute(
            "INSERT INTO user_activity (category) VALUES (?)", (category,)
        )

    def close_open_interval(self) -> None:
        self.recover_open_interval()
