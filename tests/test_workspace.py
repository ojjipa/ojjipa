"""Desktop workspace requests use real repositories and lifecycle services."""
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / 'engine/python')]
from bridge import handle_message
from attention import AttentionController
from control_database import ControlDatabase
from repos.minipa import MiniPaRepository
from repos.types import MinipaKind
from services import file_report


class WorkspaceTests(unittest.TestCase):
    def test_persisted_workspace_and_lifecycle(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'workspace.sqlite'
            db = ControlDatabase(path, ROOT / 'engine/python/migrations')
            try:
                def call(operation, payload):
                    return handle_message(db, {'protocolVersion': 1, 'messageType': operation,
                                               'payload': payload}, AttentionController(db))

                receipt = call('dump.submit', {'content': 'A saved thought'})
                self.assertEqual(receipt['decisionStatus'], 'pending')
                with db.transaction():
                    worker = MiniPaRepository(db).create(MinipaKind.TASK, 'A saved task')
                file_report(db, worker.id, 'A saved finding', True)
                data = call('workspace.get', {})
                self.assertEqual(data['thoughts'][0]['id'], receipt['dumpId'])
                self.assertEqual(data['minipas'][0]['purpose'], 'A saved task')
                self.assertEqual(data['reports'][0]['delivery'], 'held')
                for status in ('paused', 'active', 'retired'):
                    self.assertEqual(call('minipa.status', {'id': worker.id, 'status': status})['status'], status)
                with self.assertRaises(ValueError):
                    call('minipa.status', {'id': worker.id, 'status': 'active'})
            finally:
                db.close()
            reopened = ControlDatabase(path, ROOT / 'engine/python/migrations')
            try:
                data = handle_message(reopened, {'protocolVersion': 1, 'messageType': 'workspace.get', 'payload': {}})
                self.assertEqual(data['thoughts'][0]['content'], 'A saved thought')
                self.assertEqual(data['minipas'][0]['status'], 'retired')
            finally:
                reopened.close()


if __name__ == '__main__':
    unittest.main()
