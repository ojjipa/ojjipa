"""Stage a relocatable Windows CPython + real Hermes for the Tauri installer.

Build-time only: uses the prepared environment, never a user's saved settings.
"""
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import shutil
import sys

ROOT = Path(__file__).resolve().parents[3]
RESOURCES = ROOT / 'apps/desktop/src-tauri/resources'
TARGET = RESOURCES / 'runtime'
STAGING = RESOURCES / '.runtime-staging'
BASE = Path(sys.base_prefix)
PACKAGES = Path(sys.prefix) / 'Lib/site-packages'
HERMES = ROOT / 'core/vendors/hermes-agent'
if not (HERMES / 'run_agent.py').is_file():
    HERMES /= 'hermes-agent'


def discard_generated(path):
    # Resolve and check every recursive removal against the exact build outputs.
    resolved = path.resolve()
    if resolved not in (TARGET.absolute(), STAGING.absolute()) or not resolved.is_relative_to(ROOT):
        raise RuntimeError('Refusing to remove a path outside the runtime build outputs')
    if resolved.exists():
        shutil.rmtree(resolved)


def ignored(directory, names):
    return [name for name in names if name in {
        '.git', '__pycache__', '.venv', 'node_modules', '.pytest_cache',
        '.mypy_cache', '.ruff_cache', 'direct_url.json', '.env',
    } or name.startswith('__editable__') or name.endswith(('.pyc', '.pyo'))]


def copy_tree(source, target, ignore=ignored):
    shutil.copytree(source, target, ignore=ignore)


def main():
    if os.name != 'nt' or platform.machine().lower() not in ('amd64', 'x86_64'):
        raise RuntimeError('Build the Windows x64 installer on Windows x64')
    if sys.prefix == sys.base_prefix or not PACKAGES.is_dir():
        raise RuntimeError('Run this packager with the prepared .venv-hermes Python')
    if not (HERMES / 'run_agent.py').is_file():
        raise RuntimeError('The actual Hermes checkout is missing')
    for dependency in ('hermes-agent', 'websockets', 'openai', 'python-dotenv', 'ruamel.yaml'):
        importlib.metadata.version(dependency)
    RESOURCES.mkdir(parents=True, exist_ok=True)
    discard_generated(STAGING)
    python = STAGING / 'python'
    python.mkdir(parents=True)
    # Copy the base interpreter, not venv launchers (which reference the builder).
    for source in BASE.iterdir():
        if source.is_file() and (source.suffix.lower() in ('.exe', '.dll') or source.name == 'LICENSE.txt'):
            shutil.copy2(source, python / source.name)
    copy_tree(BASE / 'DLLs', python / 'DLLs')
    copy_tree(BASE / 'Lib', python / 'Lib', lambda d, names: ignored(d, names) +
              (['site-packages'] if Path(d) == BASE / 'Lib' else []))
    if (BASE / 'tcl').is_dir():
        copy_tree(BASE / 'tcl', python / 'tcl')
    copy_tree(PACKAGES, python / 'Lib/site-packages')
    app = STAGING / 'app'
    copy_tree(ROOT / 'engine/python', app / 'engine/python')
    copy_tree(ROOT / 'apps/chrome-extension', app / 'apps/chrome-extension')
    copy_tree(ROOT / 'core', app / 'core', lambda d, names: ignored(d, names) +
              (['vendors'] if Path(d) == ROOT / 'core' else []))
    # Preserve runtime code/resources. The documentation website is not executed
    # by Hermes and its deep filenames exceed NSIS's Windows path limit.
    # This only filters the generated payload; the checkout remains untouched.
    copy_tree(HERMES, app / 'core/vendors/hermes-agent', lambda d, names: ignored(d, names) +
              (['website'] if Path(d) == HERMES else []))
    notices = STAGING / 'licenses'
    notices.mkdir()
    shutil.copy2(BASE / 'LICENSE.txt', notices / 'Python-LICENSE.txt')
    shutil.copy2(HERMES / 'LICENSE', notices / 'Hermes-LICENSE.txt')
    shutil.copy2(ROOT / 'LICENSE', notices / 'OJJIPA-LICENSE.txt')
    manifest = {
        'platform': 'windows-x64', 'python': platform.python_version(),
        'packages': sorted([{'name': d.metadata['Name'], 'version': d.version}
                            for d in importlib.metadata.distributions()], key=lambda d: d['name'].lower()),
    }
    (STAGING / 'runtime-manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    for source in STAGING.rglob('*'):
        if source.is_file() and len(str(TARGET / source.relative_to(STAGING))) >= 260:
            raise RuntimeError('Installer payload path is too long; build from a shorter checkout path: ' + str(source.relative_to(STAGING)))
    discard_generated(TARGET)
    STAGING.rename(TARGET)
    print(f'Prepared standalone Python {platform.python_version()}, real Hermes, and {len(manifest["packages"])} packages.')


if __name__ == '__main__':
    main()
