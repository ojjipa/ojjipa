"""Hold delivery, real SQLite atomicity, and session timing without sleeps."""
import concurrent.futures
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / 'engine/python')]
from attention import AttentionController
from bridge import handle_message
from control_database import ControlDatabase
from core.attention.tracker import AttentionTracker
from core.attention.policy import should_surface
from core.attention.dedup import fingerprint
from repos import MiniPaRepository, ReportsRepository, HoldQueueRepository
from repos.types import MinipaKind, HoldStatus
from services import file_report_if_new, file_report, update_hold_status


class AttentionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'control.sqlite'
        self.db = ControlDatabase(self.path, ROOT / 'engine/python/migrations')
        self.now = 100.0
        self.tracker = AttentionTracker(lambda: self.now)
        self.controller = AttentionController(self.db, self.tracker)
        with self.db.transaction():
            self.agent = MiniPaRepository(self.db).create(MinipaKind.WATCHER, 'Watch papers')

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    def report(self, item='paper', agent=None):
        return file_report_if_new(self.db, agent or self.agent.id, 'feed', item, 'Report')

    def stable_messaging(self, seconds=60):
        for second in range(0, seconds + 1, 3):
            self.now = 100 + second
            self.controller.observe('messaging')

    def test_fingerprint_unambiguous_and_duplicates_scoped(self):
        self.assertNotEqual(fingerprint('ab', 'c'), fingerprint('a', 'bc'))
        self.assertEqual(fingerprint('feed', 'paper'), fingerprint('feed', 'paper'))
        self.assertIsNotNone(self.report())
        self.assertIsNone(self.report())
        with self.db.transaction():
            other = MiniPaRepository(self.db).create(MinipaKind.WATCHER, 'Independent watch')
        self.assertIsNotNone(self.report(agent=other.id))

    def test_failure_rolls_back_fingerprint_and_report(self):
        with patch.object(HoldQueueRepository, 'create', side_effect=RuntimeError('fixture')):
            with self.assertRaises(RuntimeError): self.report()
        self.assertEqual(self.db.connection.execute('SELECT COUNT(*) FROM seen_items').fetchone()[0], 0)
        self.assertEqual(self.db.connection.execute('SELECT COUNT(*) FROM reports').fetchone()[0], 0)
        self.assertIsNotNone(self.report())

    def test_concurrent_duplicate_has_one_receipt(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: self.report(), range(20)))
        self.assertEqual(sum(r is not None for r in results), 1)

    def test_unknown_holds_explicit_surface_and_terminal(self):
        _, item = self.report()
        self.assertIsNone(self.controller.tick())
        self.controller.dispatch('attention.settings', {'focus_enabled': True, 'auto_surface_enabled': False})
        delivered = self.controller.dispatch('attention.surface', {})['item']
        self.assertEqual(delivered['id'], item.id)
        self.assertIsNotNone(delivered['surfaced_at'])
        with self.assertRaises(ValueError): update_hold_status(self.db, item.id, HoldStatus.HELD)
        self.assertFalse(HoldQueueRepository(self.db).update_status(item.id, HoldStatus.HELD))
        self.assertEqual(update_hold_status(self.db, item.id, HoldStatus.SURFACED).id, item.id)

    def test_fifo_one_per_minute_and_no_held_content(self):
        _, first = self.report('first')
        _, second = self.report('second')
        before = self.controller.dispatch('attention.get', {})
        self.assertEqual(before['held_count'], 2)
        self.assertEqual(before['surfaced_reports'], [])
        self.stable_messaging()
        after = self.controller.dispatch('attention.get', {})
        self.assertEqual(after['held_count'], 1)
        self.assertEqual(after['surfaced_reports'][0]['hold_id'], first.id)
        self.now = 161
        self.assertIsNone(self.controller.tick())
        for second_at in range(163, 221, 3):
            self.now = second_at
            self.controller.observe('messaging')
        self.assertEqual(HoldQueueRepository(self.db).get_by_id(second.id).status, HoldStatus.SURFACED)

    def test_stale_gap_resets_stability(self):
        self.tracker.observe('messaging')
        self.now += 60
        self.assertFalse(should_surface(category=self.tracker.category, **self.tracker.timings(),
            focus_enabled=False, user_requested=False, auto_surface_enabled=True))
        self.tracker.observe('messaging')
        self.assertEqual(self.tracker.timings()['stable_seconds'], 0)

    def test_focus_and_auto_disable(self):
        self.report()
        self.controller.dispatch('attention.settings', {'focus_enabled': True})
        self.stable_messaging()
        self.assertEqual(self.controller.dispatch('attention.get', {})['held_count'], 1)
        self.controller.dispatch('attention.settings', {'focus_enabled': False, 'auto_surface_enabled': False})
        self.assertIsNone(self.controller.tick())
        with self.assertRaises(ValueError): self.controller.dispatch('attention.settings', {'focus_enabled': 1})

    def test_expired_item_never_surfaces(self):
        future = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
        _, expired = file_report(self.db, self.agent.id, 'Expiring', True, future)
        with self.db.transaction():
            self.db.connection.execute("UPDATE hold_queue SET created_at='2000-01-01T00:00:00.000Z', expires_at='2001-01-01T00:00:00.000Z' WHERE id=?", (expired.id,))
        _, valid = self.report('valid')
        self.assertEqual(self.controller.dispatch('attention.surface', {})['item']['id'], valid.id)
        self.assertEqual(HoldQueueRepository(self.db).get_by_id(expired.id).status, HoldStatus.EXPIRED)
        with self.assertRaises(ValueError): file_report(self.db, self.agent.id, 'bad', True, 'yesterday')

    def test_dismiss_terminal_and_restart_durable(self):
        _, item = self.report()
        self.controller.dispatch('attention.dismiss', {'id': item.id})
        with self.assertRaises(ValueError): update_hold_status(self.db, item.id, HoldStatus.SURFACED)
        self.controller.dispatch('attention.settings', {'focus_enabled': True})
        self.db.close()
        self.db = ControlDatabase(self.path, ROOT / 'engine/python/migrations')
        restarted = AttentionController(self.db)
        state = restarted.dispatch('attention.get', {})
        self.assertTrue(state['preferences']['focus_enabled'])
        self.assertEqual(state['held_count'], 0)
        self.assertEqual(restarted.tracker.category, 'unknown')
        self.assertIsNone(self.report())

    def test_bridge_operations_and_activity_intervals(self):
        def call(operation, payload):
            return handle_message(self.db, {'protocolVersion': 1, 'messageType': operation, 'payload': payload}, self.controller)
        self.assertTrue(call('activity', {'category': 'coding'})['accepted'])
        call('activity', {'category': 'coding'})
        self.assertEqual(self.db.connection.execute('SELECT COUNT(*) FROM user_activity').fetchone()[0], 1)
        self.report()
        self.assertEqual(call('attention.get', {})['held_count'], 1)
        self.assertIsNotNone(call('attention.surface', {})['item'])
        with self.assertRaises(ValueError): call('attention.dismiss', {'id': True})

    def test_policy_categories_and_boundaries(self):
        base = dict(stable_seconds=60, activity_age_seconds=0, seconds_since_last_surface=60,
                    focus_enabled=False, user_requested=False, auto_surface_enabled=True)
        for category in ('coding', 'reading', 'meeting', 'unknown'):
            self.assertFalse(should_surface(category=category, **base))
        self.assertTrue(should_surface(category='messaging', **base))
        for key, value in [('stable_seconds', 59), ('activity_age_seconds', 15), ('seconds_since_last_surface', 59), ('activity_age_seconds', -1)]:
            self.assertFalse(should_surface(category='messaging', **{**base, key: value}))


if __name__ == '__main__':
    unittest.main()
