"""Stage a relocatable CPython + real Hermes for Tauri installers.

Build-time only: uses the prepared environment, never a user's saved settings.
"""
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile
import sys
import urllib.request

ROOT = Path(__file__).resolve().parents[3]
RESOURCES = ROOT / 'apps/desktop/src-tauri/resources'
TARGET = RESOURCES / 'runtime'
STAGING = RESOURCES / '.runtime-staging'
BASE = Path(sys.base_prefix)
PACKAGES = Path(sys.prefix) / 'Lib/site-packages'
HERMES = ROOT / 'core/vendors/hermes-agent'
if not (HERMES / 'run_agent.py').is_file():
    HERMES /= 'hermes-agent'
MACOS_PYTHON_URL = (
    'https://github.com/astral-sh/python-build-standalone/releases/download/20261009/'
    'cpython-3.14.8%2B20261009-aarch64-apple-darwin-install_only.tar.gz'
)


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
    windows = os.name == 'nt' and platform.machine().lower() in ('amd64', 'x86_64')
    macos = sys.platform == 'darwin' and platform.machine().lower() == 'arm64'
    if not windows and not macos:
        raise RuntimeError('Build on Windows x64 or macOS Apple Silicon')
    packages = (Path(sys.prefix) / 'Lib/site-packages' if windows else
                Path(sys.prefix) / 'lib' / f'python{sys.version_info.major}.{sys.version_info.minor}' / 'site-packages')
    if sys.prefix == sys.base_prefix or not packages.is_dir():
        raise RuntimeError('Run this packager with the prepared .venv-hermes Python')
    if not (HERMES / 'run_agent.py').is_file():
        raise RuntimeError('The actual Hermes checkout is missing')
    for dependency in ('hermes-agent', 'websockets', 'openai', 'python-dotenv', 'ruamel.yaml'):
        importlib.metadata.version(dependency)
    RESOURCES.mkdir(parents=True, exist_ok=True)
    discard_generated(STAGING)
    python = STAGING / 'python'
    if windows:
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
        package_target = python / 'Lib/site-packages'
        python_license = python / 'LICENSE.txt'
        runtime_platform = 'windows-x64'
    else:
        archive = Path(os.environ.get('OJJIPA_PYTHON_ARCHIVE', '/private/tmp/ojjipa-python-aarch64.tar.gz'))
        if not archive.is_file():
            urllib.request.urlretrieve(MACOS_PYTHON_URL, archive)
        with tarfile.open(archive, 'r:gz') as bundle:
            members = bundle.getmembers()
            if any(Path(member.name).is_absolute() or '..' in Path(member.name).parts for member in members):
                raise RuntimeError('Standalone Python archive contains an unsafe path')
            bundle.extractall(STAGING, filter='data')
        if not (python / 'bin/python3').is_file():
            raise RuntimeError('Standalone Python archive did not contain python/bin/python3')
        package_target = python / 'lib' / f'python{sys.version_info.major}.{sys.version_info.minor}' / 'site-packages'
        python_license = python / 'lib' / f'python{sys.version_info.major}.{sys.version_info.minor}' / 'LICENSE.txt'
        runtime_platform = 'macos-aarch64'
    if package_target.exists():
        shutil.rmtree(package_target)
    copy_tree(packages, package_target)
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
    shutil.copy2(python_license, notices / 'Python-LICENSE.txt')
    shutil.copy2(HERMES / 'LICENSE', notices / 'Hermes-LICENSE.txt')
    shutil.copy2(ROOT / 'LICENSE', notices / 'OJJIPA-LICENSE.txt')
    runtime_python_version = platform.python_version()
    if macos:
        runtime_python_version = subprocess.check_output(
            [str(python / 'bin/python3'), '-c', 'import platform; print(platform.python_version())'],
            text=True,
        ).strip()
    manifest = {
        'platform': runtime_platform, 'python': runtime_python_version,
        'packages': sorted([{'name': d.metadata['Name'], 'version': d.version}
                            for d in importlib.metadata.distributions()], key=lambda d: d['name'].lower()),
    }
    (STAGING / 'runtime-manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    if windows:
        for source in STAGING.rglob('*'):
            if source.is_file() and len(str(TARGET / source.relative_to(STAGING))) >= 260:
                raise RuntimeError('Installer payload path is too long; build from a shorter checkout path: ' + str(source.relative_to(STAGING)))
    discard_generated(TARGET)
    STAGING.rename(TARGET)
    print(f'Prepared standalone Python {platform.python_version()}, real Hermes, and {len(manifest["packages"])} packages.')


if __name__ == '__main__':
    main()
