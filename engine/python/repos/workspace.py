"""Read persisted workspace data for the desktop UI."""
from dataclasses import asdict
from repos.dumps import DumpsRepository
from repos.decisions import DecisionsRepository
from repos.ai import AIRepository
from repos.minipa import MiniPaRepository


class WorkspaceRepository:
    def __init__(self, database):
        self.database = database

    def snapshot(self):
        connection = self.database.connection
        thoughts = []
        for item in DumpsRepository(self.database).list_recent(100):
            thought = asdict(item)
            decisions = DecisionsRepository(self.database).list_for_dump(item.id)
            if decisions:
                decision = asdict(decisions[0])
                minipa = MiniPaRepository(self.database).get_by_id(decision['minipa_id']) if decision['minipa_id'] else None
                decision['minipa'] = asdict(minipa) if minipa else None
                thought['decision'] = decision
            thoughts.append(thought)
        reports = [dict(row) for row in connection.execute(
            'SELECT r.id, r.minipa_id, r.content, r.created_at, h.id AS hold_id, h.status AS delivery '
            'FROM reports r LEFT JOIN hold_queue h ON h.report_id=r.id ORDER BY r.id DESC LIMIT 100')]
        # Deliver held metadata only; content is released when the policy surfaces it.
        for report in reports:
            if report['delivery'] == 'held':
                report['content'] = ''
        return {
            'thoughts': thoughts,
            'minipas': [dict(row) for row in connection.execute(
                'SELECT id, kind, purpose, status, termination_condition FROM minipa ORDER BY id DESC LIMIT 100')],
            'reports': reports,
            'jobs': [dict(row) for row in connection.execute('SELECT * FROM ai_jobs ORDER BY id DESC LIMIT 100')],
            'memories': AIRepository(self.database).memories(),
        }
