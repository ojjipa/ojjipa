"""Bounded subprocess management; this module contains no agent loop."""
import asyncio
import json
import os
from pathlib import Path
import shutil
import signal
import tempfile


class HermesRuntime:
    def __init__(self, directory, settings):
        self.directory = Path(directory).resolve()
        self.settings = settings
        self.slots = asyncio.Semaphore(3)

    async def run(self, prompt, system, *, full_tools=False, classifier=False):
        config = self.settings.resolved()
        self.settings.require_model(config)
        source = Path(config['hermes_path'])
        if not (source / 'run_agent.py').is_file():
            raise RuntimeError('The OJJIPA agent runtime is missing from this installation. Repair or reinstall OJJIPA.')
        async with self.slots:
            self.directory.mkdir(parents=True, exist_ok=True)
            task_directory = Path(config['working_directory'])
            if full_tools and not classifier:
                task_directory.mkdir(parents=True, exist_ok=True)
            workspace = Path(tempfile.mkdtemp(prefix='minipa-', dir=self.directory))
            process = None
            try:
                environment = os.environ.copy()
                # Never inherit Hermes state, plugins, credentials or filesystem grants.
                for key in list(environment):
                    if key.startswith('HERMES_') or key in ('OPENAI_API_KEY', 'OPENROUTER_API_KEY'):
                        environment.pop(key, None)
                environment.update(HERMES_HOME=str(workspace / 'hermes'),
                                   PYTHONDONTWRITEBYTECODE='1', PYTHONUTF8='1',
                                   OJJIPA_WORKER_KEY=config['api_key'])
                if config.get('tavily_key'):
                    environment['TAVILY_API_KEY'] = config['tavily_key']
                budget = 90 if classifier else config['timeout_seconds']
                request = dict(source=str(source), model=config['model'], base_url=config['base_url'],
                               full_tools=full_tools and not classifier, iterations=3 if classifier else 16, timeout=budget,
                               prompt=prompt, system=system)
                process = await asyncio.create_subprocess_exec(
                    config['hermes_python'], '-B', str(Path(__file__).with_name('worker.py')),
                    cwd=task_directory if full_tools and not classifier else workspace,
                    env=environment, stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                    start_new_session=os.name != 'nt')
                try:
                    stdout, stderr = await asyncio.wait_for(
                        process.communicate(json.dumps(request).encode()), budget + 30)
                except asyncio.TimeoutError:
                    raise RuntimeError(f'Hermes exceeded its {budget}-second execution budget') from None
                try:
                    result = json.loads(stdout.decode())
                except (ValueError, UnicodeError):
                    detail = stderr.decode(errors='replace')[-1800:]
                    raise RuntimeError('Hermes could not start: ' + detail.replace(config['api_key'], '[redacted]')) from None
                if process.returncode or result.get('error'):
                    raise RuntimeError(str(result.get('error') or 'Hermes execution failed').replace(config['api_key'], '[redacted]'))
                if not result.get('completed') or not result.get('summary', '').strip():
                    raise RuntimeError('Hermes ended before completing the assigned purpose: ' + result.get('summary', '')[:700])
                return result
            finally:
                # Cancellation and pause cannot leave a model/tool process running.
                if process is not None and process.returncode is None:
                    if os.name == 'nt':
                        # Windows venv Python is a launcher with a child interpreter.
                        # Killing only the launcher would leave the agent running.
                        killer = await asyncio.create_subprocess_exec(
                            'taskkill', '/PID', str(process.pid), '/T', '/F',
                            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
                        await killer.wait()
                        if process.returncode is None:
                            try:
                                process.kill()
                            except ProcessLookupError:
                                pass
                    else:
                        try:
                            os.killpg(process.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                    await process.wait()
                if workspace.resolve().is_relative_to(self.directory):
                    shutil.rmtree(workspace, ignore_errors=True)
