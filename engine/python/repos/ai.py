"""Persistence for OJJIPA's jobs and explicitly promoted Grandpa memory."""
class AIRepository:
    def __init__(self, db):
        self.db = db

    def enqueue(self, *, phase, dump_id=None, minipa_id=None):
        cursor = self.db.connection.execute('INSERT INTO ai_jobs(phase,dump_id,minipa_id) VALUES(?,?,?)', (phase,dump_id,minipa_id))
        return int(cursor.lastrowid)

    def due(self):
        return [dict(row) for row in self.db.connection.execute(
            "SELECT j.* FROM ai_jobs j LEFT JOIN minipa m ON m.id=j.minipa_id "
            "WHERE j.status='queued' AND j.due_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now') "
            "AND (j.minipa_id IS NULL OR m.status='active') ORDER BY j.due_at,j.id LIMIT 3")]

    def get(self, job_id):
        row = self.db.connection.execute('SELECT * FROM ai_jobs WHERE id=?', (job_id,)).fetchone()
        return dict(row) if row else None

    def claim(self, job_id):
        return self.db.connection.execute("UPDATE ai_jobs SET status='running',attempts=attempts+1,error=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status='queued'", (job_id,)).rowcount > 0

    def finish(self, job_id, status, error=None, delay_minutes=0, due_at=None):
        self.db.connection.execute("UPDATE ai_jobs SET status=?,error=?,due_at=COALESCE(?,strftime('%Y-%m-%dT%H:%M:%fZ','now',?)),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?", (status,error,due_at,f'+{delay_minutes} minutes',job_id))

    def scheduled_watches(self):
        return [dict(row) for row in self.db.connection.execute("SELECT j.id,m.id AS minipa_id,m.config FROM ai_jobs j JOIN minipa m ON m.id=j.minipa_id WHERE j.phase='watch' AND j.status='queued' AND m.status IN ('active','paused')")]

    def recover(self):
        self.db.connection.execute("UPDATE ai_jobs SET status='queued',error='Interrupted by app shutdown; retrying' WHERE status='running'")
        self.db.connection.execute("UPDATE ai_jobs SET status='cancelled' WHERE status='queued' AND minipa_id IN (SELECT id FROM minipa WHERE status='retired')")

    def retry(self, job_id):
        return self.db.connection.execute("UPDATE ai_jobs SET status='queued',error=NULL,due_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status='failed'", (job_id,)).rowcount > 0

    def remember(self, content, dump_id):
        self.db.connection.execute('INSERT INTO grandpa_memory(content,source_dump_id) VALUES(?,?) ON CONFLICT(content) DO NOTHING', (content,dump_id))

    def memories(self):
        return [dict(row) for row in self.db.connection.execute('SELECT * FROM grandpa_memory ORDER BY id DESC LIMIT 50')]

    def forget(self, memory_id):
        self.db.connection.execute('DELETE FROM grandpa_memory WHERE id=?', (memory_id,))

    def all_memories(self):
        return [dict(row) for row in self.db.connection.execute('SELECT * FROM grandpa_memory ORDER BY id DESC')]

    def has_execution(self, minipa_id):
        return self.db.connection.execute("SELECT 1 FROM ai_jobs WHERE minipa_id=? AND phase IN ('work','watch') AND status IN ('queued','running','failed')", (minipa_id,)).fetchone() is not None

    def cancel_for_minipa(self, minipa_id):
        self.db.connection.execute("UPDATE ai_jobs SET status='cancelled' WHERE minipa_id=? AND status IN ('queued','failed')", (minipa_id,))
