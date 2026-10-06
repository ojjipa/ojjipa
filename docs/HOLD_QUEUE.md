# Hold queue

SHA-256 fingerprints identify results within each MiniPa/source. Feed IDs or
stable item URLs are supplied by the producer; changed summary wording does
not create another identity. The database uniqueness constraint resolves
overlapping writers. Different MiniPas can independently report the same item.

`services.file_report_if_new(db, minipa_id, source, item_id, content)` records
the fingerprint, report and held item in one transaction. A duplicate returns
None; a new result returns `(Report, HeldItem)`. If a write fails, all three
roll back. Optional `expires_at` must be a future ISO timestamp with timezone;
the service normalizes it to UTC. Omitting it keeps the report held indefinitely.

`AttentionTracker` uses monotonic session timers. Changed categories and gaps
of 15 seconds reset stability. It starts with unknown activity after every
engine restart; persisted activity intervals do not imply current availability.

Automatic delivery requires fresh activity, 60 seconds of messaging, focus off,
automatic delivery enabled, and 60 seconds since the last delivery. Coding,
reading, meetings and unknown remain held. Explicit delivery bypasses those
restrictions. Each check selects just the oldest unexpired item, with ID breaking
timestamp ties. Expiration runs before selection. Focus and automatic-delivery
preferences survive restarts in migration 0003.

The FSM allows held -> surfaced/dismissed/expired. Terminal items never return
to held. Repeating a status is a harmless retry. Surfaced means available to a
consumer, not proof the user saw it. Dismiss applies to a held item; read-state
or dismissal of already-presented content would be a separate future feature.
No transition reason or Grandpa audit row is required by this subsystem.

The bridge runs checks every second off its async event loop. Rust sends category
heartbeats every three seconds; repeated observations reuse the same database
interval. Controller locking serializes tracker updates with delivery, while a
database transaction protects selection and status changes. One Python attention
controller is supported per desktop database. Multiple independent engine
processes are outside this contract.

## Desktop API

React can invoke the Tauri command `hold_queue_request`:

```typescript
const state = await invoke('hold_queue_request', {
  operation: 'attention.get', payload: {},
});
```

| Operation | Payload | Result |
| --- | --- | --- |
| `attention.get` | `{}` | preferences, held_count, surfaced_reports (latest 100) |
| `attention.settings` | optional boolean focus_enabled / auto_surface_enabled | saved preferences |
| `attention.surface` | `{}` | item or null; one explicit delivery |
| `attention.dismiss` | positive integer id | item or null |

Held content is not included in the state response. Automatic delivery changes
SQLite state; a frontend should refresh attention.get to display available
reports. Existing React is a placeholder and has no report presentation UI.
Watcher execution is a separate producer; it should call file_report_if_new.

## Verification

Run `python -B -m unittest discover -s tests -p 'test_attention*.py' -v` from
the project root. Tests use temporary databases and a controllable clock, without
provider calls or changing the user's app-data database.
