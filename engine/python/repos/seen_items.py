from control_database import ControlDatabase


class SeenItemsRepository:
    def __init__(self, database: ControlDatabase):
        self._database = database

    def record_if_new(self, source: str, item_key: str) -> bool:
        cursor = self._database.connection.execute(
            """
            INSERT INTO seen_items (source, item_key)
            VALUES (?, ?)
            ON CONFLICT(source, item_key) DO NOTHING
            """,
            (source, item_key),
        )
        return cursor.rowcount == 1