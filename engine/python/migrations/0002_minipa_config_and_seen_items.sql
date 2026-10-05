ALTER TABLE minipa
ADD COLUMN config TEXT NOT NULL DEFAULT '{}';

CREATE TABLE seen_items (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL,
    item_key TEXT NOT NULL,
    first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (source, item_key)
);
CREATE INDEX idx_seen_items_last_seen ON seen_items(last_seen_at DESC);

CREATE TABLE grandpa_actions_new (
    id INTEGER PRIMARY KEY,
    report_id INTEGER REFERENCES reports(id),
    minipa_id INTEGER REFERENCES minipa(id),
    decision TEXT NOT NULL CHECK (length(trim(decision)) > 0),
    reason TEXT NOT NULL,
    decided_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO grandpa_actions_new
    (id, report_id, minipa_id, decision, reason, decided_at)
SELECT id, report_id, minipa_id, decision, reason, decided_at
FROM grandpa_actions;
DROP TABLE grandpa_actions;
ALTER TABLE grandpa_actions_new RENAME TO grandpa_actions;

DROP TRIGGER minipa_set_updated_at;
CREATE TRIGGER minipa_set_updated_at
AFTER UPDATE OF kind, purpose, source, termination_condition, scope, config, status ON minipa
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
    UPDATE minipa
    SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = NEW.id;
END;
