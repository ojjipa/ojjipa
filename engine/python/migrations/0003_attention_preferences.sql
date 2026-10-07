CREATE TABLE attention_preferences (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    focus_enabled INTEGER NOT NULL DEFAULT 0 CHECK (focus_enabled IN (0, 1)),
    auto_surface_enabled INTEGER NOT NULL DEFAULT 1 CHECK (auto_surface_enabled IN (0, 1))
);
INSERT INTO attention_preferences (id) VALUES (1);
CREATE INDEX idx_hold_status_created ON hold_queue(status, created_at, id);
