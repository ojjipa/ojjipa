"""OJJIPA's loopback transport for Hermes's actual browser-control broker."""
import asyncio
import json
import os
from pathlib import Path
import secrets
from urllib.parse import urlparse
import websockets

CAPABILITIES = ['browser_snapshot', 'browser_navigate', 'browser_click', 'browser_type',
                'browser_scroll', 'browser_back', 'browser_press', 'browser_tabs', 'browser_tab_activate']


class BrowserRelay:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.port = 8766
        self.server = None
        self.current = None
        self.pending = {}
        self.leases = {}
        self.lock = asyncio.Lock()
        self.error = ''
        path = self.directory / 'chrome-pairing.json'
        try:
            self.token = json.loads(path.read_text(encoding='utf-8'))['token']
            if not isinstance(self.token, str) or len(self.token) < 32:
                raise ValueError('Invalid pairing state')
        except (OSError, ValueError, KeyError, TypeError):
            self.token = secrets.token_urlsafe(32)
            self.directory.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps({'token': self.token}), encoding='utf-8')
            if os.name != 'nt':
                path.chmod(0o600)

    async def start(self):
        self.loop = asyncio.get_running_loop()
        try:
            self.server = await websockets.serve(self.handle, '127.0.0.1', self.port,
                                                 max_size=512 * 1024, ping_interval=20)
        except OSError:
            self.error = 'Chrome connection port 8766 is unavailable. Close other OJJIPA instances and restart.'

    def public(self):
        peer = self.current
        return {'connected': peer is not None, 'port': self.port, 'error': self.error,
                'title': peer['tab'].get('title', '') if peer else '',
                'url': peer['tab'].get('url', '') if peer else ''}

    def pairing(self):
        if self.error:
            raise RuntimeError(self.error)
        return {'code': self.token, 'port': self.port}

    def request_disconnect(self):
        asyncio.run_coroutine_threadsafe(self.disconnect(), self.loop).result(timeout=5)
        return self.public()

    async def disconnect(self):
        if self.current:
            await self.current['socket'].close(1000, 'Disconnected from OJJIPA')

    async def acquire(self):
        if not self.current:
            return None
        await self.lock.acquire()
        if not self.current:
            self.lock.release()
            raise RuntimeError('The approved Chrome tab disconnected before execution')
        peer = self.current
        key = secrets.token_urlsafe(32)
        lease = {'url': f'ws://127.0.0.1:{self.port}', 'token': key,
                 'controller_id': peer['id'], 'profile_id': peer['profile'],
                 'tab': dict(peer['tab']), 'capabilities': list(CAPABILITIES)}
        self.leases[key] = lease
        return lease

    async def snapshot(self, lease):
        """Read the approved tab once before Hermes starts reasoning."""
        if not lease or not self.current or lease['controller_id'] != self.current['id']:
            raise RuntimeError('The approved Chrome tab is unavailable')
        command_id = secrets.token_urlsafe(18)
        future = self.loop.create_future()
        self.pending[command_id] = (self.current['id'], future)
        frame = {'method': 'browser.controller.command', 'params': {
            'command_id': command_id, 'action': 'browser_snapshot', 'arguments': {'full': True}}}
        try:
            await self.current['socket'].send(json.dumps(frame))
            result = await asyncio.wait_for(future, 25)
            if not result.get('ok'):
                raise RuntimeError(str(result.get('result') or 'Chrome could not read the approved tab'))
            return result.get('result')
        finally:
            self.pending.pop(command_id, None)

    def release(self, lease):
        if lease:
            self.leases.pop(lease['token'], None)
            self.lock.release()

    async def close(self):
        if self.server:
            self.server.close()
            await self.server.wait_closed()

    @staticmethod
    def tab(value):
        if not isinstance(value, dict) or type(value.get('id')) is not int:
            raise ValueError('An approved Chrome tab is required')
        url = str(value.get('url', ''))
        if urlparse(url).scheme not in ('http', 'https'):
            raise ValueError('Only HTTP(S) tabs can be connected')
        return {'id': value['id'], 'title': str(value.get('title', ''))[:300], 'url': url[:4000]}

    async def handle(self, socket):
        peer = None
        try:
            hello = json.loads(await asyncio.wait_for(socket.recv(), 5))
            if not isinstance(hello, dict):
                raise ValueError('Invalid browser handshake')
            origin = socket.request.headers.get('Origin', '')
            if hello.get('role') == 'controller':
                if not origin.startswith('chrome-extension://') or not secrets.compare_digest(str(hello.get('token', '')), self.token):
                    raise ValueError('Chrome pairing was rejected')
                if self.current:
                    raise ValueError('Disconnect the existing tab before connecting another')
                peer = {'id': secrets.token_hex(16), 'socket': socket,
                        'profile': str(hello.get('profile', ''))[:100], 'tab': self.tab(hello.get('tab'))}
                self.current = peer
                await socket.send(json.dumps({'type': 'ready'}))
                async for raw in socket:
                    frame = json.loads(raw)
                    if frame.get('type') == 'state':
                        tab = self.tab(frame.get('tab'))
                        if tab['id'] != peer['tab']['id']:
                            raise ValueError('The approved tab cannot be changed by the controller')
                        peer['tab'] = tab
                    elif frame.get('type') == 'result':
                        pending = self.pending.get(frame.get('command_id'))
                        if pending and pending[0] == peer['id'] and not pending[1].done():
                            pending[1].set_result({'ok': frame.get('ok') is True, 'result': frame.get('result')})
                    # Keepalive frames only maintain the extension service worker.
            elif hello.get('role') == 'worker' and not origin:
                lease = self.leases.get(hello.get('token'))
                current = self.current
                if not lease or not current or lease['controller_id'] != current['id']:
                    raise ValueError('The execution no longer owns an approved Chrome tab')
                frame = json.loads(await asyncio.wait_for(socket.recv(), 5))
                params = frame.get('params', {})
                if frame.get('method') != 'browser.controller.command' or params.get('action') not in CAPABILITIES:
                    raise ValueError('Unsupported Chrome command')
                command_id = params['command_id']
                if command_id in self.pending:
                    raise ValueError('Duplicate Chrome command')
                future = self.loop.create_future()
                self.pending[command_id] = (current['id'], future)
                closed = asyncio.create_task(socket.wait_closed())
                try:
                    await current['socket'].send(json.dumps(frame))
                    done, _ = await asyncio.wait([future, closed], timeout=25, return_when=asyncio.FIRST_COMPLETED)
                    if future not in done:
                        raise RuntimeError('Chrome command cancelled or timed out')
                    await socket.send(json.dumps(future.result()))
                finally:
                    self.pending.pop(command_id, None)
                    closed.cancel()
                    await asyncio.gather(closed, return_exceptions=True)
                    if not future.done():
                        future.cancel()
                        try:
                            await current['socket'].send(json.dumps({'method': 'browser.controller.cancel', 'params': {'command_id': command_id}}))
                        except websockets.ConnectionClosed:
                            pass
            else:
                raise ValueError('Invalid browser connection')
        except (ValueError, KeyError, RuntimeError, asyncio.TimeoutError) as error:
            try:
                await socket.send(json.dumps({'type': 'error', 'ok': False, 'result': str(error)}))
            except websockets.ConnectionClosed:
                pass
        except websockets.ConnectionClosed:
            pass
        finally:
            if peer and self.current is peer:
                self.current = None
                for identity, future in self.pending.values():
                    if identity == peer['id'] and not future.done():
                        future.set_result({'ok': False, 'result': 'The approved Chrome tab disconnected'})
