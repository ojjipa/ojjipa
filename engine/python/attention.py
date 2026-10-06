from dataclasses import asdict
from threading import RLock
from core.attention.tracker import AttentionTracker
from repos.attention import AttentionRepository
from repos.types import HoldStatus
from services import record_activity, surface_next_held, update_hold_status, update_attention_preferences, count_held_items


class AttentionController:
    def __init__(self, database, tracker=None):
        self.database = database
        self.tracker = tracker or AttentionTracker()
        self._lock = RLock()

    def observe(self, category):
        with self._lock:
            record_activity(self.database, category)
            self.tracker.observe(category)
            return self._tick()

    def _tick(self, user_requested=False):
        item = surface_next_held(self.database, self.tracker, user_requested=user_requested)
        return asdict(item) if item else None

    def tick(self):
        with self._lock:
            return self._tick()

    def dispatch(self, operation, payload):
        with self._lock:
            if operation == 'attention.surface':
                if payload:
                    raise ValueError('attention.surface takes no arguments')
                return {'item': self._tick(user_requested=True)}
            if operation == 'attention.settings':
                return update_attention_preferences(self.database, payload)
            if operation == 'attention.dismiss':
                if set(payload) != {'id'} or type(payload['id']) is not int or payload['id'] < 1:
                    raise ValueError('A positive hold item ID is required')
                item = update_hold_status(self.database, payload['id'], HoldStatus.DISMISSED)
                return {'item': asdict(item) if item else None}
            if operation == 'attention.get':
                if payload:
                    raise ValueError('attention.get takes no arguments')
                # Expire due items but do not implicitly surface on a read.
                from services import expire_due_hold_items
                expire_due_hold_items(self.database)
                repository = AttentionRepository(self.database)
                return {'preferences': repository.preferences(),
                        'held_count': count_held_items(self.database),
                        'surfaced_reports': repository.surfaced_reports()}
            raise ValueError('Unsupported attention operation')
