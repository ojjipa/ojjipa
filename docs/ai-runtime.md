# OJJIPA AI runtime

## Running

Start the desktop from `apps/desktop` with `npm run tauri dev`.
Settings → AI models & API contains model, API base URL, keys, Hermes checkout,
Python executable and execution budget. Save & check connection invokes real
Hermes against the configured provider. Existing Windows-protected Nebius
settings are read automatically. Model secrets never appear in settings replies;
Windows saves them using DPAPI, other platforms use a file readable only by its owner.

The isolated `.venv-hermes` environment uses the vendored checkout's declared
dependencies. On a new computer, create this environment and install that checkout:

```powershell
python -m venv .venv-hermes
.\.venv-hermes\Scripts\python.exe -m pip install -e .\core\vendors\hermes-agent\hermes-agent
```

The source path is configurable, so a single-level Hermes checkout works as well.
The engine's `websockets` dependency remains in `engine/python/requirements.txt`.

## Flow

1. Capture commits a dump and its Grandpa job in one transaction, then replies immediately.
2. Grandpa invokes Hermes with no tools to classify noise/task/watch. No SQLite
   transaction is held while the model works.
3. A decision and its MiniPa/execution job commit together. Noise ends here.
4. A MiniPa starts the actual `run_agent.AIAgent` in an isolated subprocess.
   OJJIPA owns its purpose, workspace, budget, cancellation and permitted tools.
5. A completed Hermes answer becomes a structured report. Directly requested
   tasks surface immediately and retire. Watcher reports enter the existing hold queue.
6. The UI polls persisted state, displays errors and supports retry, pause,
   resume, retire, held delivery and forgetting Grandpa memory.

`core/hermes/worker.py` is a runtime entry point, not an agent loop. Hermes owns
reasoning, provider requests, tool execution and independent tool concurrency.
OJJIPA runs at most three concurrent executions, with separate Hermes homes.
Pause kills the current process; resume starts the bounded execution again.
Retire is terminal. Interrupted jobs recover on app startup.

## Permissions and current scope

The user has granted task workers the full available Hermes toolset. Hermes's
native tool selection (`enabled_toolsets=None`) exposes files, shell, coding,
browser, skills, delegation and configured integrations. Provider-specific tools
still require their native dependencies and credentials. Grandpa classification
and feed relevance evaluation run without tools. Hermes session state stays
temporary; task cwd is OJJIPA's managed `tasks` folder in app-data.
Generated files and edits are not removed by session cleanup. The
session workspace is not an OS sandbox.

Grandpa promotes only explicitly stated preferences/corrections into durable
memory, not Hermes transcripts. Settings exposes these records and Forget.
Each installation creates `grandpa/user.md` (confirmed user profile/preferences)
and `grandpa/memory.md` (curated facts/corrections) underneath the same app-data
directory as its SQLite database. On the current Windows installation these are
in `%APPDATA%/com.admin.desktop/grandpa/`. The engine creates missing files from
neutral bundled templates with exclusive creation, preserving existing files
across restarts and updates. Personal files are never loaded from the checkout.
`core/grandpa/memory/architecture.md` provides shared application facts separately.
Personal files, shared architecture, and learned database memory are read for
each job, with a 4,000-character context budget per source, then supplied to
Grandpa and its assigned MiniPa. The personal files are manually maintained;
they are not automatic database exports. Forgetting a database record does not
edit them. Distribution packages must include the neutral templates and shared
architecture reference, never a development machine's app-data directory.
User inputs and relevant remembered context go to the chosen model endpoint;
read-only research may use the configured web provider.

The watcher preset is arXiv RSS/Atom. It validates category, limits feed size,
uses existing SHA256 seen-item dedup scoped to MiniPa, evaluates relevance via
Hermes and retries transient failures with backoff. Scheduling runs while
OJJIPA is open (including hidden in the tray), not while the machine/app is off.
Requested intervals can be as short as one minute. Explicit finite durations
retire the watcher automatically. Periodic reading recommendations use arXiv's
search API to obtain a cached pool of matching papers, release one unread paper
per scheduled tick, and mark only that paper seen. These directly requested timed
deliveries bypass holding; ordinary background findings still use the hold policy.
The arXiv pool is cached for 15 minutes, so rapid delivery does not repeatedly
poll arXiv. Delivery depends on available matching papers, service connectivity,
the app staying open, and available scheduler slots.

The transport and migrations remain in the existing engine. Migration 0008 adds
job and Grandpa memory persistence without altering earlier legacy tables.
Old saved thoughts can use Ask Grandpa; active MiniPas without a job can start
an execution from their UI controls.

## Windows installer runtime

The Windows x64 build stages a standalone CPython interpreter, its standard
library, all installed packages from `.venv-hermes`, the actual Hermes checkout,
the Python engine/migrations, and OJJIPA core. Tauri installs these as resources.
The generated payload excludes Git/cache files and Hermes's documentation
website; the original checkout and runtime functionality are preserved.
These resources live under `runtime/`. Release builds resolve them through Tauri's resource directory,
not the developer checkout or the user's system Python. Secrets and personal
app-data are never inputs to this packaging step. Interpreter paths and task
directories are managed internally and are not user settings.

On the build machine, prepare `.venv-hermes` with the Hermes dependencies and
`engine/python/requirements.txt`, then run `npm run tauri -- build` from
`apps/desktop`. The pre-build hook stages the runtime automatically; it rejects
non-Windows-x64 hosts. Other platforms need their own native runtime packaging.
Package metadata and dependency licenses are retained, and
`runtime/runtime-manifest.json` records the shipped Python/package versions.
Generated resources are ignored by Git. Rebuild the installer after any Python
source or dependency change. Optional tools may still require their external
programs or service credentials; packaging does not provision those services.
