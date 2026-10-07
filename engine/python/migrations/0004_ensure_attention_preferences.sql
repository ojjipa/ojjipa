-- Earlier development branches used version 3 for other tables. Keep their
-- records intact while ensuring the attention schema exists on either branch.
CREATE TABLE IF NOT EXISTS attention_preferences (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    focus_enabled INTEGER NOT NULL DEFAULT 0 CHECK (focus_enabled IN (0, 1)),
    auto_surface_enabled INTEGER NOT NULL DEFAULT 1 CHECK (auto_surface_enabled IN (0, 1))
);
INSERT INTO attention_preferences (id) VALUES (1) ON CONFLICT(id) DO NOTHING;
CREATE INDEX IF NOT EXISTS idx_hold_status_created ON hold_queue(status, created_at, id);
