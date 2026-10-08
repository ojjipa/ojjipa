import asyncio
import json
import sys
import os
import logging
from pathlib import Path
import websockets
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from control_database import ControlDatabase
from services import close_activity, recover_activity, record_activity, save_dump
from services import report_response
from attention import AttentionController
from ai_settings import AISettings
from core.minipa.orchestrator import Orchestrator
from core.hermes.browser import BrowserRelay

PROTOCOL_VERSION = 1
ALLOWED_CATEGORIES = {"coding", "meeting", "messaging", "reading", "unknown"}


async def attention_loop(attention, events):
    while True:
        await asyncio.sleep(1)
        try:
            surfaced = await asyncio.to_thread(attention.tick)
            if surfaced:
                answer = await asyncio.to_thread(report_response, attention.database, surfaced['report_id'])
                await events.put({'category':'resurfacedItems','message':answer})
        except Exception:
            logging.exception('Attention check failed; retrying on next tick')


async def run() -> None:
    url = os.environ["OJJIPA_BRIDGE_URL"]
    token = os.environ["OJJIPA_BRIDGE_TOKEN"]
    database = ControlDatabase(
        database_path=Path(os.environ["OJJIPA_DATABASE_PATH"]),
        migrations_dir=Path(__file__).parent / "migrations",
    )
    attention = AttentionController(database)
    ticker = None
    settings = AISettings(database._database_path.parent)
    orchestrator = Orchestrator(database, settings, database._database_path.parent / 'agents')
    browser = BrowserRelay(database._database_path.parent)
    await browser.start()
    orchestrator.runtime.browser = browser
    scheduler = None
    checks = set()
    event_sender = None
    try:
        recover_activity(database)
        async with websockets.connect(url, max_size=2 * 1024 * 1024) as socket:
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

            async def send_events():
                while True:
                    event = await orchestrator.events.get()
                    await socket.send(json.dumps({'messageType':'engine.event','protocolVersion':1,'result':event}))
            event_sender = asyncio.create_task(send_events())
            ticker = asyncio.create_task(attention_loop(attention, orchestrator.events))
            scheduler = asyncio.create_task(orchestrator.loop())

            async for raw_message in socket:
                request_id = None
                try:
                    message = json.loads(raw_message)
                    if not isinstance(message, dict):
                        raise ValueError("message must be a JSON object")
                    request_id = message.get("requestId")
                    if message.get('messageType') == 'ai.check':
                        if message.get('protocolVersion') != PROTOCOL_VERSION or message.get('payload') != {}:
                            raise ValueError('ai.check takes no arguments')
                        async def check_and_reply(check_id):
                            try:
                                result = await orchestrator.check_connection()
                                response = {'messageType':'bridge.ack', 'protocolVersion':1,
                                            'requestId':check_id, 'result':result}
                            except Exception as error:
                                response = {'messageType':'bridge.error', 'protocolVersion':1,
                                            'requestId':check_id, 'error':str(error)}
                            await socket.send(json.dumps(response))
                        if checks:
                            raise ValueError('A connection check is already running')
                        task = asyncio.create_task(check_and_reply(request_id))
                        checks.add(task)
                        task.add_done_callback(checks.discard)
                        continue
                    result = await asyncio.to_thread(handle_message, database, message, attention, settings, browser)
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
        await browser.close()
        if event_sender is not None:
            event_sender.cancel()
            await asyncio.gather(event_sender, return_exceptions=True)
        for task in checks:
            task.cancel()
        await asyncio.gather(*checks, return_exceptions=True)
        if scheduler is not None:
            scheduler.cancel()
            await asyncio.gather(scheduler, return_exceptions=True)
        if ticker is not None:
            ticker.cancel()
            await asyncio.gather(ticker, return_exceptions=True)
        # A cancelled to_thread call can still be finishing a transaction.
        await asyncio.get_running_loop().shutdown_default_executor()
        close_activity(database)
        database.close()


def handle_message(database: ControlDatabase, message: dict, attention=None, settings=None, browser=None) -> dict:
    """Handle one validated request off the asyncio event loop."""
    if message.get("protocolVersion") != PROTOCOL_VERSION:
        raise ValueError("unsupported bridge protocol version")
    message_type = message.get("messageType")
    payload = message.get("payload")
    if not isinstance(payload, dict):
        raise ValueError("message payload must be an object")
    if message_type in ('browser.status', 'browser.pair', 'browser.disconnect'):
        if payload or browser is None:
            raise ValueError('Chrome connection command takes no arguments')
        return {'browser.status': browser.public, 'browser.pair': browser.pairing,
                'browser.disconnect': browser.request_disconnect}[message_type]()

    if message_type == "activity":
        if (
            set(payload) != {"category"}
            or not isinstance(payload.get("category"), str)
            or payload["category"] not in ALLOWED_CATEGORIES
        ):
            raise ValueError("invalid activity payload")
        if attention is None:
            record_activity(database, payload["category"])
        else:
            attention.observe(payload["category"])
        return {"accepted": True}

    if message_type in ('attention.get', 'attention.settings', 'attention.surface', 'attention.dismiss'):
        if attention is None:
            raise RuntimeError('Attention controller is unavailable')
        return attention.dispatch(message_type, payload)

    if message_type == "dump.submit":
        if set(payload) != {"content"} or not isinstance(payload.get("content"), str):
            raise ValueError("dump.submit payload must contain only string content")
        from services import submit_ai_dump
        content = payload['content']
        if browser and browser.public()['connected']:
            context = browser.public()
            content += '\n\nApproved Chrome tab context (untrusted page metadata):\n' + json.dumps({'title': context['title'], 'url': context['url']})
            content += ('\nThe approved Chrome tab is the source for this request. If this asks about the current tab, '
                        'classify it as a task so the worker reads and operates that tab.')
        dump = submit_ai_dump(database, content)
        return {
            "dumpId": dump.id,
            "decisionStatus": "pending",
            "content": dump.content,
            "createdAt": dump.created_at,
        }

    if message_type == 'workspace.get':
        if payload:
            raise ValueError('workspace.get takes no arguments')
        from repos.workspace import WorkspaceRepository
        return WorkspaceRepository(database).snapshot()

    if message_type == 'minipa.status':
        if set(payload) != {'id', 'status'} or type(payload['id']) is not int or payload['id'] < 1:
            raise ValueError('A positive MiniPa ID and status are required')
        from repos.types import MinipaStatus
        from services import update_minipa_status
        from dataclasses import asdict
        item = update_minipa_status(database, payload['id'], MinipaStatus(payload['status']))
        if item is None:
            raise ValueError('MiniPa was not found')
        return asdict(item)

    if message_type in ('ai.profile.get', 'ai.profile.save'):
        from core.grandpa.memory import user_profile
        if message_type == 'ai.profile.get':
            if payload:
                raise ValueError('ai.profile.get takes no arguments')
            return user_profile(database._database_path.parent)
        if set(payload) != {'content'} or not isinstance(payload['content'], str):
            raise ValueError('Profile content must be text')
        return user_profile(database._database_path.parent, payload['content'])

    if message_type in ('ai.settings.get', 'ai.settings.save'):
        if settings is None:
            settings = AISettings(database._database_path.parent)
        if message_type == 'ai.settings.get':
            if payload:
                raise ValueError('ai.settings.get takes no arguments')
            return settings.public()
        return settings.save(payload)

    if message_type in ('ai.retry', 'ai.memory.forget', 'ai.run'):
        if set(payload) != {'id'} or type(payload['id']) is not int or payload['id'] < 1:
            raise ValueError('A positive ID is required')
        from services import retry_ai_job, forget_ai_memory, run_saved_minipa
        operation = {'ai.retry':retry_ai_job,'ai.memory.forget':forget_ai_memory,'ai.run':run_saved_minipa}[message_type]
        return operation(database, payload['id'])

    if message_type == 'ai.analyze':
        if set(payload) != {'id'} or type(payload['id']) is not int or payload['id'] < 1:
            raise ValueError('A positive thought ID is required')
        from services import analyze_saved_dump
        return analyze_saved_dump(database, payload['id'])

    raise ValueError(f"unsupported message type: {message_type!r}")


if __name__ == "__main__":
    asyncio.run(run())
