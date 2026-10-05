import asyncio
import json
import os
from pathlib import Path
import websockets
from control_database import ControlDatabase
from services import close_activity, record_activity, recover_activity

PROTOCOL_VERSION = 1
ALLOWED_CATEGORIES = {"coding", "meeting", "messaging", "reading", "unknown"}


async def run() -> None:
    url = os.environ["OJJIPA_BRIDGE_URL"]
    token = os.environ["OJJIPA_BRIDGE_TOKEN"]
    database = ControlDatabase(
        database_path=Path(os.environ["OJJIPA_DATABASE_PATH"]),
        migrations_dir=Path(__file__).parent / "migrations",
    )
    try:
        recover_activity(database)
        async with websockets.connect(url, max_size=64 * 1024) as socket:
            await socket.send(
                json.dumps(
                    {
                        "messageType": "hello",
                        "protocolVersion": PROTOCOL_VERSION,
                        "token": token,
                    }
                )
            )
            ready = json.loads(await socket.recv())
            if ready != {"messageType": "ready", "protocolVersion": PROTOCOL_VERSION}:
                raise RuntimeError("Rust bridge rejected the protocol handshake")

            async for raw_message in socket:
                message = json.loads(raw_message)
                payload = message.get("payload")
                if (
                    message.get("messageType") != "activity"
                    or message.get("protocolVersion") != PROTOCOL_VERSION
                    or not isinstance(payload, dict)
                    or set(payload) != {"category"}
                    or not isinstance(payload.get("category"), str)
                    or payload["category"] not in ALLOWED_CATEGORIES
                ):
                    raise ValueError("Received an invalid or unsanitized activity message")
                record_activity(database, payload["category"])
    finally:
        close_activity(database)
        database.close()


if __name__ == "__main__":
    asyncio.run(run())
