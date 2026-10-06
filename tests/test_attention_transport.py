"""Exercise the real engine process and authenticated request/reply protocol."""
import asyncio
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
import websockets

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / 'engine/python')]
from control_database import ControlDatabase
from repos import MiniPaRepository
from repos.types import MinipaKind
from services import file_report_if_new


class AttentionTransportTests(unittest.IsolatedAsyncioTestCase):
    async def test_process_protocol_and_restart(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'control.sqlite'
            db = ControlDatabase(path, ROOT / 'engine/python/migrations')
            with db.transaction():
                agent = MiniPaRepository(db).create(MinipaKind.WATCHER, 'Transport fixture')
            file_report_if_new(db, agent.id, 'fixture', 'one', 'Fixture report')
            db.close()
            for iteration in range(2):
                connected = asyncio.get_running_loop().create_future()
                release = asyncio.Event()

                async def accept(socket):
                    connected.set_result(socket)
                    await release.wait()

                async with websockets.serve(accept, '127.0.0.1', 0) as server:
                    port = server.sockets[0].getsockname()[1]
                    process = await asyncio.create_subprocess_exec(
                        sys.executable, '-B', str(ROOT / 'engine/python/bridge.py'),
                        env={**os.environ, 'OJJIPA_BRIDGE_URL': f'ws://127.0.0.1:{port}',
                             'OJJIPA_BRIDGE_TOKEN': 'fixture-token', 'OJJIPA_DATABASE_PATH': str(path)},
                        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                    )
                    try:
                        socket = await asyncio.wait_for(connected, 10)
                        hello = json.loads(await socket.recv())
                        self.assertEqual(hello['token'], 'fixture-token')
                        await socket.send(json.dumps({'messageType': 'ready', 'protocolVersion': 1}))

                        async def call(operation, payload):
                            await socket.send(json.dumps({'messageType': operation, 'protocolVersion': 1,
                                                          'requestId': 'fixture-id', 'payload': payload}))
                            response = json.loads(await asyncio.wait_for(socket.recv(), 5))
                            self.assertEqual(response['requestId'], 'fixture-id')
                            return response

                        state = (await call('attention.get', {}))['result']
                        if not iteration:
                            self.assertEqual(state['held_count'], 1)
                            await call('attention.settings', {'focus_enabled': True})
                            response = await call('attention.surface', {})
                            self.assertEqual(response['result']['item']['status'], 'surfaced')
                            bad = await call('attention.dismiss', {'id': response['result']['item']['id']})
                            self.assertEqual(bad['messageType'], 'bridge.error')
                        else:
                            self.assertTrue(state['preferences']['focus_enabled'])
                            self.assertEqual(state['held_count'], 0)
                            self.assertEqual(state['surfaced_reports'][0]['content'], 'Fixture report')
                        receipt = await call('dump.submit', {'content': 'Transport fixture'})
                        self.assertEqual(receipt['messageType'], 'bridge.ack')
                        await socket.close()
                        await asyncio.wait_for(process.wait(), 10)
                        self.assertEqual(process.returncode, 0, (await process.stderr.read()).decode())
                    finally:
                        release.set()
                        if process.returncode is None:
                            process.kill()
                            await process.wait()


if __name__ == '__main__':
    unittest.main()
