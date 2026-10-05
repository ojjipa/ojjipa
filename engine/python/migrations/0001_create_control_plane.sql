CREATE TABLE dumps (
    id INTEGER PRIMARY KEY,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE minipa (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('watcher', 'task')),
    purpose TEXT NOT NULL,
    source TEXT,
    termination_condition TEXT,
    scope TEXT NOT NULL DEFAULT 'global',
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'paused', 'retired')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE decisions (
    id INTEGER PRIMARY KEY,
    dump_id INTEGER NOT NULL REFERENCES dumps(id),
    verdict TEXT NOT NULL CHECK (verdict IN ('noise', 'task', 'watch')),
    reason TEXT,
    minipa_id INTEGER REFERENCES minipa(id),
    decided_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK (
        (verdict = 'noise' AND minipa_id IS NULL)
        OR (verdict IN ('task', 'watch') AND minipa_id IS NOT NULL)
    )
);

CREATE TABLE user_activity (
    id INTEGER PRIMARY KEY,
    category TEXT NOT NULL CHECK (category IN ('coding', 'reading', 'meeting', 'messaging', 'unknown')),
    start_time TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    end_time TEXT,
    CHECK (end_time IS NULL OR end_time >= start_time)
);
CREATE INDEX idx_activity_start ON user_activity(start_time DESC);

CREATE TABLE reports (
    id INTEGER PRIMARY KEY,
    minipa_id INTEGER NOT NULL REFERENCES minipa(id),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE grandpa_actions (
    id INTEGER PRIMARY KEY,
    report_id INTEGER REFERENCES reports(id),
    minipa_id INTEGER REFERENCES minipa(id),
    decision TEXT NOT NULL,
    reason TEXT NOT NULL,
    decided_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE hold_queue (
    id INTEGER PRIMARY KEY,
    report_id INTEGER NOT NULL UNIQUE REFERENCES reports(id),
    status TEXT NOT NULL DEFAULT 'held'
        CHECK (status IN ('held', 'surfaced', 'dismissed', 'expired')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    expires_at TEXT,
    surfaced_at TEXT,
    CHECK (expires_at IS NULL OR expires_at >= created_at),
    CHECK (status != 'surfaced' OR surfaced_at IS NOT NULL)
);

CREATE TRIGGER minipa_set_updated_at
AFTER UPDATE OF kind, purpose, source, termination_condition, scope, status ON minipa
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
    UPDATE minipa
    SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = NEW.id;
END;
