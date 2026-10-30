<p align="center">
  <img src="https://github.com/user-attachments/assets/12079208-f2d7-48fc-b85a-33ef70240f2a" width="200" />
</p>

<h3 align="center">A local control plane for autonomous AI agents,<br/>built around human attention.</h3>

<p align="center">
  <a href="#what-ojjipa-does">What it does</a> · <a href="#architecture">Architecture</a> · <a href="#quick-start">Quick start</a> · <a href="#tech-stack">Tech stack</a> · <a href="#project-structure">Project structure</a> · <a href="#license">License</a>
</p>

---

## What OJJIPA does

Most agent frameworks assume the user is always available. OJJIPA takes the opposite approach: it watches *how busy you are* and coordinates background work around that signal.

The core loop:

1. **Capture** — you drop a thought (text, file, voice memo — whatever) into a system-wide quick-capture bar (`⌘⌥⇧Space`).
2. **Decide** — *Grandpa*, an LLM-powered judgment layer running on [Nebius Token Factory](https://studio.nebius.com/), reads the thought and classifies it: **noise** (discard), **task** (one-off work), or **watch** (ongoing monitoring).
3. **Dispatch** — for tasks and watches, Grandpa drafts a *MiniPa* — a small, scoped background worker with a clear purpose, termination condition, and config.
4. **Hold** — when MiniPas produce findings, Grandpa decides whether to interrupt you now or hold the result until your attention opens up.
5. **Surface** — held results are delivered at the right moment, based on your live activity category (coding, meeting, messaging, reading, or idle).

Everything runs locally. The database is SQLite. Window titles never leave your machine — only broad activity categories like "coding" reach the engine.

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    OJJIPA Desktop (Tauri)                 │
│                                                          │
│  ┌──────────┐    ┌──────────┐    ┌───────────────────┐   │
│  │ React UI │◄──►│ Rust core│◄──►│ Python engine      │   │
│  │          │    │          │    │ (WebSocket bridge)  │   │
│  └──────────┘    └────┬─────┘    └────────┬──────────┘   │
│                       │                    │              │
│              macOS/Win │           SQLite   │  Nebius API  │
│              platform  │           (WAL)   │  (LLM calls) │
│              APIs      │                   │              │
└────────────────────────┴───────────────────┴──────────────┘
```

| Component | Role |
|-----------|------|
| **Grandpa** | Judgment layer. Classifies thoughts, drafts MiniPas, decides when to surface findings. |
| **MiniPa** | Lightweight background worker. Scoped to a single purpose. Reports back to Grandpa. |
| **Hermes** | Execution and tooling layer for MiniPas. *(Planned)* |
| **Protocol** | Shared contracts between components. *(Planned)* |

### Data flow

```
User thought ──► Rust bridge ──► Python engine ──► Nebius LLM ──► IntakeDecision
                                      │
                                      ▼
                               SQLite control DB
                          (dumps, decisions, minipa,
                           activity, reports, hold_queue)
```

The Tauri process spawns the Python engine as a child process on startup, connects over a localhost WebSocket with a one-time token, and exchanges messages using a versioned JSON protocol. Activity monitoring runs a 3-second poll via macOS Accessibility APIs (or Win32 on Windows), categorizes the foreground window, and sends only the category string to the engine.

---

## Quick start

### Prerequisites

- [Rust](https://rustup.rs/) (stable)
- [Node.js](https://nodejs.org/) ≥ 18
- Python ≥ 3.10
- A [Nebius Token Factory](https://studio.nebius.com/) API key and an enabled model ID

### Build and run

```bash
# Clone
git clone https://github.com/ojjipa/ojjipa.git
cd ojjipa

# Install Python dependency
python3 -m pip install -r engine/python/requirements.txt

# Install frontend dependencies
cd apps/desktop
npm install

# Run in development mode
npm run tauri dev
```

On first launch, open **Settings → AI Models & API** to enter your Nebius API key and a Grandpa model ID. The API key is stored in your OS credential manager — it never touches the filesystem or the webview.

### Quick capture

Press **⌘ ⌥ ⇧ Space** (customizable in Settings) to open the floating capture bar over any app. Type a thought, hit ⌘ Enter, and it's saved and classified in the background.

---

## Tech stack

| Layer | Technology |
|-------|------------|
| Desktop shell | [Tauri 2](https://v2.tauri.app/) (Rust) |
| Frontend | React + TypeScript (Vite) |
| Engine | Python 3, `websockets` |
| Database | SQLite (WAL mode, foreign keys, migration-versioned schema) |
| LLM inference | [Nebius Token Factory](https://studio.nebius.com/) (OpenAI-compatible API) |
| Platform APIs | macOS Accessibility (Objective-C FFI), Win32 |
| Credential storage | OS keychain via `keyring` crate |
| Notifications | Native desktop notifications via Tauri plugin |

---

## Project structure

```
ojjipa/
├── apps/
│   └── desktop/                # Tauri desktop application
│       ├── src/                # React frontend (TypeScript)
│       ├── src-tauri/          # Rust backend
│       │   ├── src/
│       │   │   ├── lib.rs      # App setup, Tauri commands, tray, shortcuts
│       │   │   ├── bridge.rs   # WebSocket bridge to Python engine
│       │   │   └── platform/   # macOS & Windows active-window detection
│       │   └── capabilities/   # Tauri permission manifests
│       └── public/             # Static assets
├── engine/
│   └── python/                 # Python engine
│       ├── bridge.py           # WebSocket client, message dispatch
│       ├── services.py         # Business logic, transaction boundaries
│       ├── model_gateway.py    # Nebius Token Factory LLM calls
│       ├── control_database.py # Thread-safe SQLite with migrations
│       ├── repos/              # Data access layer
│       │   ├── types.py        # Domain types (Dump, MiniPa, Decision, ...)
│       │   ├── activity.py     # User activity intervals
│       │   ├── decisions.py    # Grandpa's intake decisions
│       │   ├── dumps.py        # Raw captured thoughts
│       │   ├── grandpa_actions.py  # Grandpa's review actions
│       │   ├── hold_queue.py   # Findings held for surfacing
│       │   ├── minipa.py       # MiniPa lifecycle
│       │   └── reports.py      # MiniPa reports
│       ├── migrations/         # Numbered SQL migrations
│       └── tests/              # Unit tests
├── core/                       # Core component stubs
│   ├── grandpa/                # Judgment layer
│   ├── minipa/                 # Agent workers
│   ├── hermes/                 # Execution layer
│   └── protocol/               # Shared contracts
├── assets/brand/               # Logos and illustrations
└── docs/                       # Documentation
```

---

## Current status

OJJIPA was built during the **NVIDIA Hackathon**. Here's what works and what's next:

### Working

- Full desktop shell with system tray, quick capture shortcut, and dual-window architecture
- Thought capture → LLM classification → SQLite persistence pipeline
- Grandpa's intake decision engine (noise / task / watch) via Nebius Token Factory
- MiniPa draft creation from Grandpa's decisions
- Live activity monitoring with privacy-preserving category detection (macOS + Windows)
- Attention-aware hold queue with expiration
- Settings UI for API keys (stored in OS keychain), model configuration, notifications, themes, and shortcut customization
- Dark/light theme support

### Next

- [ ] MiniPa execution engine (Hermes) — actually run the drafted workers
- [ ] Live report surfacing based on attention state
- [ ] Scheduled reminders and time-based resurfacing
- [ ] Packaged Python sidecar for distribution (no host Python required)
- [ ] Multi-agent coordination protocol

---

## Privacy

OJJIPA is local-first by design:

- Your **database** is a SQLite file in your OS application data directory
- **Window titles** and app names are used for categorization *inside the Rust process only* — they are never sent to the Python engine or written to the database
- Only a **broad activity category** (`coding`, `meeting`, `messaging`, `reading`, `unknown`) reaches the engine
- **Thought text** is sent to Nebius Token Factory for classification — this is the only network call
- Your **API key** is stored in the OS credential manager, not in any file

---

## License

[Apache 2.0](LICENSE)
