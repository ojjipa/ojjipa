import asyncio
import json
import os
from pathlib import Path
import websockets
from control_database import ControlDatabase
from model_gateway import ModelError, decide_dump
from services import close_activity, intake_dump, recover_activity, record_activity, save_dump

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
        if (
            set(payload) != {"content", "maxThinkingSeconds"}
            or not isinstance(payload.get("content"), str)
            or not isinstance(payload.get("maxThinkingSeconds"), int)
            or isinstance(payload.get("maxThinkingSeconds"), bool)
            or not 5 <= payload["maxThinkingSeconds"] <= 120
        ):
            raise ValueError(
                "dump.submit requires string content and a thinking limit from 5 to 120 seconds"
            )
        content = payload["content"]
        if not content.strip():
            raise ValueError("dump content must be a non-empty string")

        try:
            decision = decide_dump(content, payload["maxThinkingSeconds"])
        except ModelError as error:
            dump = save_dump(database, content)
            return {
                "dumpId": dump.id,
                "content": dump.content,
                "createdAt": dump.created_at,
                "decisionStatus": "pending",
                "analysisError": str(error),
            }

        dump, decision_record, minipa = intake_dump(database, content, decision)
        return {
            "dumpId": dump.id,
            "content": dump.content,
            "createdAt": dump.created_at,
            "decisionStatus": "complete",
            "decision": {
                "id": decision_record.id,
                "verdict": decision_record.verdict.value,
                "reason": decision_record.reason,
                "minipa": (
                    {
                        "id": minipa.id,
                        "kind": minipa.kind.value,
                        "purpose": minipa.purpose,
                    }
                    if minipa is not None
                    else None
                ),
            },
        }

    raise ValueError(f"unsupported message type: {message_type!r}")


if __name__ == "__main__":
    asyncio.run(run())
