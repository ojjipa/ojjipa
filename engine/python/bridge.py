import asyncio
import json
import os
from pathlib import Path
import websockets
from control_database import ControlDatabase
from services import close_activity, recover_activity, record_activity, save_dump

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
                request_id = None
                try:
                    message = json.loads(raw_message)
                    if not isinstance(message, dict):
                        raise ValueError("message must be a JSON object")
                    request_id = message.get("requestId")
                    result = await asyncio.to_thread(
                        handle_message, database, message
                    )
                    response = {
                        "messageType": "bridge.ack",
                        "protocolVersion": PROTOCOL_VERSION,
                        "requestId": request_id,
                        "result": result,
                    }
                except Exception as error:
                    response = {
                        "messageType": "bridge.error",
                        "protocolVersion": PROTOCOL_VERSION,
                        "requestId": request_id,
                        "error": str(error),
                    }
                await socket.send(json.dumps(response))
    finally:
        close_activity(database)
        database.close()


def handle_message(database: ControlDatabase, message: dict) -> dict:
    """Handle one validated request off the asyncio event loop."""
    if message.get("protocolVersion") != PROTOCOL_VERSION:
        raise ValueError("unsupported bridge protocol version")
    message_type = message.get("messageType")
    payload = message.get("payload")
    if not isinstance(payload, dict):
        raise ValueError("message payload must be an object")

    if message_type == "activity":
        if (
            set(payload) != {"category"}
            or not isinstance(payload.get("category"), str)
            or payload["category"] not in ALLOWED_CATEGORIES
        ):
            raise ValueError("invalid activity payload")
        record_activity(database, payload["category"])
        return {"accepted": True}

    if message_type == "dump.submit":
        if set(payload) != {"content"} or not isinstance(payload.get("content"), str):
            raise ValueError("dump.submit payload must contain only string content")
        dump = save_dump(database, payload["content"])
        return {
            "dumpId": dump.id,
            "content": dump.content,
            "createdAt": dump.created_at,
        }

    raise ValueError(f"unsupported message type: {message_type!r}")


if __name__ == "__main__":
    asyncio.run(run())
