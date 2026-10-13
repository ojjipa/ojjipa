"""Local runtime settings. Secrets are protected with Windows DPAPI."""
import base64
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import sys
from urllib.parse import urlparse


def protect(value, decrypt=False):
    if os.name != 'nt':
        return value
    class Blob(ctypes.Structure):
        _fields_ = [('size', wintypes.DWORD), ('data', ctypes.POINTER(ctypes.c_ubyte))]
    raw = base64.b64decode(value) if decrypt else value.encode()
    buffer = ctypes.create_string_buffer(raw)
    source = Blob(len(raw), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)))
    output = Blob()
    function = ctypes.windll.crypt32.CryptUnprotectData if decrypt else ctypes.windll.crypt32.CryptProtectData
    if not function(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(output)):
        raise RuntimeError('Windows could not protect the model credentials')
    try:
        result = ctypes.string_at(output.data, output.size)
        return result.decode() if decrypt else base64.b64encode(result).decode()
    finally:
        ctypes.windll.kernel32.LocalFree(output.data)


class AISettings:
    def __init__(self, directory):
        self.path = Path(directory) / 'ai-settings.json'

    def resolved(self):
        data = json.loads(self.path.read_text()) if self.path.exists() else {}
        legacy = {}
        previous = self.path.with_name('agent-settings.json')
        if previous.exists():
            try:
                stored = json.loads(previous.read_text())
                if stored.get('protection') == 'windows-dpapi' and os.name == 'nt':
                    legacy = json.loads(protect(stored['data'], decrypt=True))
            except (ValueError, KeyError, RuntimeError):
                # A copied legacy file may belong to another Windows account.
                # Current settings can still be configured normally.
                legacy = {}
        root = Path(__file__).resolve().parents[2]
        source = root / 'core/vendors/hermes-agent'
        if not (source / 'run_agent.py').exists():
            source = source / 'hermes-agent'
        python = root / '.venv-hermes' / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
        result = {
            'model': data.get('model') or os.environ.get('OJJIPA_MODEL') or legacy.get('model', ''),
            'base_url': data.get('base_url') or os.environ.get('OJJIPA_MODEL_BASE_URL') or legacy.get('base_url', 'https://api.tokenfactory.nebius.com/v1'),
            'hermes_path': str(source),
            'hermes_python': os.environ.get('OJJIPA_HERMES_PYTHON') or (str(python) if python.exists() else sys.executable),
            'timeout_seconds': data.get('timeout_seconds', 240),
            'working_directory': str(self.path.parent / 'tasks'),
        }
        for key, variable in [('api_key','OJJIPA_MODEL_API_KEY'), ('tavily_key','TAVILY_API_KEY')]:
            stored = data.get(key)
            result[key] = protect(stored, decrypt=True) if stored else os.environ.get(variable) or legacy.get('tavily_api_key' if key == 'tavily_key' else key, '')
        return result

    def public(self):
        config = self.resolved()
        return {k:v for k,v in config.items() if k not in ('api_key','tavily_key','hermes_path','hermes_python','working_directory')} | {
            'has_api_key': bool(config['api_key']), 'has_tavily_key': bool(config['tavily_key'])}

    def save(self, changes):
        allowed = {'model','base_url','api_key','tavily_key','timeout_seconds'}
        if not isinstance(changes, dict) or set(changes) - allowed:
            raise ValueError('Unknown model setting')
        data = json.loads(self.path.read_text()) if self.path.exists() else {}
        for key, value in changes.items():
            if key == 'timeout_seconds':
                if type(value) is not int or not 30 <= value <= 900:
                    raise ValueError('Execution budget must be between 30 and 900 seconds')
            elif not isinstance(value, str):
                raise ValueError(f'{key} must be text')
            elif key in ('api_key','tavily_key'):
                if not value.strip():
                    continue  # A blank field preserves the saved credential.
                value = protect(value.strip())
            else:
                value = value.strip()
            if key == 'base_url':
                url = urlparse(value)
                if url.scheme not in ('https','http') or not url.hostname or url.username or url.password:
                    raise ValueError('Use an HTTP(S) API base URL without credentials')
                if url.scheme == 'http' and url.hostname not in ('localhost','127.0.0.1','::1'):
                    raise ValueError('Remote model endpoints require HTTPS')
            data[key] = value
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix('.tmp')
        temporary.write_text(json.dumps(data), encoding='utf-8')
        if os.name != 'nt':
            temporary.chmod(0o600)
        temporary.replace(self.path)
        return self.public()

    @staticmethod
    def require_model(config):
        if not config['model'] or not config['api_key']:
            raise RuntimeError('Configure your model name and API key in Settings → AI models & API')
