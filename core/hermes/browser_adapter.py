"""Attach OJJIPA transport to the real Hermes broker inside a worker process."""
import json
import os
import inspect
from pathlib import Path


def attach_browser(config, session_id):
    from gateway.browser_control_broker import get_browser_control_broker, ControllerScope
    from websockets.sync.client import connect
    home = Path(os.environ['HERMES_HOME'])
    home.mkdir(parents=True, exist_ok=True)
    (home / 'config.yaml').write_text('browser:\n  extension_control:\n    enabled: true\n', encoding='utf-8')
    os.environ.update(HERMES_SESSION_ID=session_id, HERMES_BROWSER_CONTROL_PRINCIPAL='ojjipa-local',
                      HERMES_BROWSER_CONTROL_TRANSPORT_FAMILY='ojjipa')
    broker = get_browser_control_broker()
    scope = ControllerScope(principal_id='ojjipa-local', profile_id='ojjipa', session_id=session_id,
                            controller_id=config['controller_id'], browser_profile_id=config['profile_id'],
                            transport_family='ojjipa', capabilities=frozenset(config['capabilities']))

    def send(frame):
        if frame.get('method') != 'browser.controller.command':
            return
        options = {'proxy': None} if 'proxy' in inspect.signature(connect).parameters else {}
        with connect(config['url'], open_timeout=5, max_size=512 * 1024, **options) as socket:
            socket.send(json.dumps({'role': 'worker', 'token': config['token']}))
            socket.send(json.dumps(frame))
            result = json.loads(socket.recv(timeout=28))
            broker.complete(frame['params']['command_id'], scope=scope,
                            ok=result.get('ok') is True, result=result.get('result'))

    broker.attach(scope, send)
    # This isolated process is one MiniPa. Pin native Hermes browser routing to
    # its approved controller, including any Hermes-delegated work. Reuse the
    # upstream router's capability checks and broker; never switch backends.
    from tools import browser_extension_router as routing
    from gateway.browser_control_broker import ControllerUnavailable
    def unavailable():
        raise ControllerUnavailable('The approved OJJIPA Chrome tab is unavailable')
    def route(action, args, *, fallback, **kwargs):
        return routing.route_browser_tool(action, args, fallback=unavailable, broker=broker,
            enabled=True, session_id=session_id, principal_id=scope.principal_id,
            transport_family=scope.transport_family,
            tool_call_id=kwargs.get('tool_call_id') or routing.current_tool_call_id())
    routing.routed_browser_handler = route
    routing.extension_controller_available = lambda action: broker.select(scope, action) is not None
    # Hermes browser tools import these symbols directly at module load time;
    # update those module references as well as the router module itself.
    import tools.browser_tool as browser_tool
    browser_tool.routed_browser_handler = route
    browser_tool.extension_controller_available = lambda action: broker.select(scope, action) is not None
    try:
        import tools.browser_cdp_tool as browser_cdp_tool
        browser_cdp_tool.routed_browser_handler = route
    except ImportError:
        pass
    return broker, scope
