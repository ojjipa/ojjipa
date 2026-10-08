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
    # Hermes logs must never corrupt the adapter's JSON protocol on stdout.
    with contextlib.redirect_stdout(sys.stderr):
        from run_agent import AIAgent
        agent = AIAgent(
            model=request['model'], base_url=request['base_url'],
            api_key=os.environ['OJJIPA_WORKER_KEY'], provider='custom', api_mode='chat_completions',
            # None is Hermes's documented full available-tool selection.
            enabled_toolsets=None if request['full_tools'] else [],
            max_iterations=request['iterations'], run_budget_seconds=request['timeout'],
            quiet_mode=True, save_trajectories=False, skip_context_files=True,
            skip_memory=True, skip_background_review=True, load_soul_identity=False,
            cwd=str(Path.cwd()), ephemeral_system_prompt=request['system'],
            reasoning_config={'enabled':False}, max_tokens=6000 if request['full_tools'] else 1800,
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
