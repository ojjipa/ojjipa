import time
from .policy import MAX_ACTIVITY_AGE_SECONDS
CATEGORIES = frozenset({'coding', 'reading', 'meeting', 'messaging', 'unknown'})
class AttentionTracker:
    def __init__(self, clock=time.monotonic):
        self._clock = clock
        self.category = 'unknown'
        self.category_since = clock()
        self.last_observed_at = None
        self.last_surfaced_at = None
    def observe(self, category: str) -> None:
        if category not in CATEGORIES:
            raise ValueError('Invalid activity category')
        now = self._clock()
        gap = (self.last_observed_at is None
               or now - self.last_observed_at >= MAX_ACTIVITY_AGE_SECONDS)
        if category != self.category or gap:
            self.category_since = now
        self.category = category
        self.last_observed_at = now
    def mark_surfaced(self) -> None:
        self.last_surfaced_at = self._clock()
    def timings(self) -> dict[str, float]:
        now = self._clock()
        return {
            'stable_seconds': now - self.category_since,
            'activity_age_seconds': float('inf') if self.last_observed_at is None else now - self.last_observed_at,
            'seconds_since_last_surface': float('inf') if self.last_surfaced_at is None else now - self.last_surfaced_at,
        }
