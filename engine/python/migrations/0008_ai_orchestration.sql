-- OJJIPA scheduling state, separate from the retired experimental agent tables.
CREATE TABLE ai_jobs (
    id INTEGER PRIMARY KEY,
    dump_id INTEGER REFERENCES dumps(id),
    minipa_id INTEGER REFERENCES minipa(id),
    phase TEXT NOT NULL CHECK (phase IN ('judge','work','watch')),
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed','cancelled')),
    error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    due_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_ai_jobs_due ON ai_jobs(status,due_at);
CREATE UNIQUE INDEX idx_ai_judge_dump ON ai_jobs(dump_id) WHERE phase='judge';
CREATE TABLE grandpa_memory (
    id INTEGER PRIMARY KEY,
    content TEXT NOT NULL UNIQUE,
    source_dump_id INTEGER REFERENCES dumps(id),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
