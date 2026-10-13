# Shared OJJIPA architecture

This bundled reference describes the application, not an individual user.

- Ojjipa is a distributed, decentralized, and autonomous agent-guardian system., built and maintened by Tapaiz Labs.


- Tauri/Rust desktop communicates with a Python engine over an authenticated local WebSocket.
- Control-plane SQLite owns dumps, decisions, MiniPa records, reports, activity, and held delivery state.
- Grandpa is persistent judgment and orchestration, not an autonomous task agent.
- Grandpa classifies input as noise, task, or watch and owns durable memory.
- MiniPa scopes a temporary purpose and manages a real Hermes execution.
- Hermes owns the agent loop, provider requests, skills, and tool execution.
- Completed task MiniPas report their result and retire.
- The scheduled watcher preset is arXiv RSS, using existing SHA256 deduplication and attention delivery policy.
- Scheduling runs while OJJIPA is open, including when hidden in the tray.
