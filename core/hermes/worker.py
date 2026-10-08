"""Isolated process entry point. All reasoning and tools run in real Hermes."""
import contextlib
import json
import os
from pathlib import Path
import sys
import traceback


def main():
    request = json.loads(sys.stdin.read())
    sys.path.insert(0, request['source'])
    # Use Hermes's supported identity slot instead of its default product identity.
    hermes_home = Path(os.environ['HERMES_HOME'])
    hermes_home.mkdir(parents=True, exist_ok=True)
    (hermes_home / 'SOUL.md').write_text(
        'You are OJJIPA, built and maintained by Tapaiz Labs. '
        'When asked who built you or OJJIPA, answer Tapaiz Labs. '
        'OJJIPA uses Hermes Agent by Nous Research as its execution runtime; '
        'distinguish the application creator from the upstream runtime author '
        'when asked about the underlying technology. '
        'Be concise, accurate, and clear about what you actually verified.\n',
        encoding='utf-8')
    # Hermes logs must never corrupt the adapter's JSON protocol on stdout.
    with contextlib.redirect_stdout(sys.stderr):
        browser_binding = None
        if request.get('browser'):
            from browser_adapter import attach_browser
            browser_binding = attach_browser(request['browser'], request['browser_session'])
        from run_agent import AIAgent
        def tool_completed(call_id, name, arguments, result):
            # Require an initial execution, then let Hermes either continue
            # using tools or return its final answer. Requiring every turn
            # prevents normal completion and therefore MiniPa retirement.
            agent.request_overrides = {
                **(agent.request_overrides or {}), 'tool_choice': 'auto'}

        agent = AIAgent(
            model=request['model'], base_url=request['base_url'],
            api_key=os.environ['OJJIPA_WORKER_KEY'], provider='custom', api_mode='chat_completions',
            # None is Hermes's documented full available-tool selection.
            # Full MiniPa tasks must receive the capabilities OJJIPA promised:
            # browser control, terminal, files, web and skills. Relying on
            # Hermes defaults can silently omit browser/file tools.
            enabled_toolsets=(['browser', 'terminal', 'file', 'skills']
                              if request.get('browser') else
                              ['terminal', 'file', 'web', 'skills']) if request['full_tools'] else [],
            max_iterations=request['iterations'], run_budget_seconds=request['timeout'],
            quiet_mode=True, save_trajectories=False, skip_context_files=True,
            skip_memory=True, skip_background_review=True, load_soul_identity=True,
            cwd=str(Path.cwd()), ephemeral_system_prompt=request['system'],
            session_id=request.get('browser_session'),
            reasoning_config={'enabled':False}, max_tokens=6000 if request['full_tools'] else 1800,
            # A full MiniPa is an execution task, not a chat turn. Require the
            # provider to emit a real tool call before Hermes can answer.
            request_overrides={'tool_choice': 'required'} if request['full_tools'] else None,
            tool_complete_callback=tool_completed if request['full_tools'] else None,
        )
        if not request['full_tools']:
            # Grandpa classification and feed evaluation only need inference.
            agent.tools = []
            agent.valid_tool_names = set()
        agent._persist_disabled = True
        try:
            result = agent.run_conversation(request['prompt'])
        finally:
            agent.close()
            if browser_binding:
                browser_binding[0].detach(browser_binding[1])
    print(json.dumps({
        'completed': bool(result.get('completed')),
        'summary': str(result.get('final_response') or ''),
        'error': str(result.get('error') or ''),
        'api_calls': result.get('api_calls', 0),
    }, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({'completed': False, 'summary': '', 'error': f'{type(error).__name__}: {error}'}))
        sys.exit(1)
