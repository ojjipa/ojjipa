"""Grandpa's durable context policy; persistence stays in control-plane repos."""
from pathlib import Path
import os
import tempfile


def sync_memory(records, app_data_directory):
    """Rebuild the managed section from committed memories, preserving user notes."""
    path = initialize_memory(app_data_directory) / 'memory.md'
    start, end = '<!-- grandpa:memories:start -->', '<!-- grandpa:memories:end -->'
    existing = path.read_text(encoding='utf-8')
    entries = '\n'.join('- ' + ' '.join(record['content'].split()) for record in records)
    block = start + '\n' + entries + '\n' + end
    if start in existing and end in existing:
        before, remainder = existing.split(start, 1)
        _, after = remainder.split(end, 1)
        updated = before + block + after
    else:
        updated = existing.rstrip() + '\n\n' + block + '\n'
    if updated == existing:
        return
    descriptor, temporary = tempfile.mkstemp(dir=path.parent, prefix='memory-', suffix='.tmp')
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as target:
            target.write(updated)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def user_profile(app_data_directory, content=None):
    directory = initialize_memory(app_data_directory)
    path = directory / 'user.md'
    if content is not None:
        if not isinstance(content, str) or len(content) > 4000:
            raise ValueError('Your profile must be text of at most 4,000 characters')
        descriptor, temporary = tempfile.mkstemp(dir=directory, prefix='user-', suffix='.tmp')
        try:
            with os.fdopen(descriptor, 'w', encoding='utf-8') as target:
                target.write(content)
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    return {'content': path.read_text(encoding='utf-8-sig')}


def initialize_memory(app_data_directory):
    """Seed per-installation files once; never overwrite a user's edits."""
    directory = Path(app_data_directory) / 'grandpa'
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    templates = Path(__file__).resolve().parent
    for name in ('user.md', 'memory.md'):
        if (directory / name).exists():
            continue
        content = (templates / name).read_text(encoding='utf-8')
        try:
            with (directory / name).open('x', encoding='utf-8') as target:
                target.write(content)
            (directory / name).chmod(0o600)
        except FileExistsError:
            pass
    return directory


def context_from_records(records, directory):
    # Reload curated files for each job so edits apply to subsequent judgments.
    # Give each source a budget so one large file cannot crowd out the others.
    sections = []
    directory = Path(directory)
    sources = [(directory / 'user.md', 'Confirmed user profile'),
               (directory / 'memory.md', 'Curated Grandpa memory'),
               (Path(__file__).resolve().parent / 'architecture.md', 'Shared OJJIPA architecture')]
    for path, label in sources:
        if path.is_file():
            with path.open(encoding='utf-8-sig', errors='replace') as source:
                content = source.read(4000).strip()
            if content:
                sections.append(f'## {label}\n{content}')
    learned = '\n'.join(record['content'] for record in records)[:4000]
    if learned:
        sections.append('## Remembered user preferences and corrections\n' + learned)
    return '\n\n'.join(sections)
