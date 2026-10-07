import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from bridge import handle_message
from control_database import ControlDatabase
from model_gateway import ModelConfigurationError
from repos import DecisionsRepository, DumpsRepository, MiniPaRepository
from repos.types import IntakeDecision, MinipaDraft, MinipaKind, Verdict


class DumpInferenceTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        root = Path(__file__).resolve().parents[1]
        self.database = ControlDatabase(
            database_path=Path(self.temp_dir.name) / "test.sqlite",
            migrations_dir=root / "migrations",
        )

    def tearDown(self):
        self.database.close()
        self.temp_dir.cleanup()

    def message(self, content="Monitor arXiv for new papers", seconds=30):
        return {
            "protocolVersion": 1,
            "messageType": "dump.submit",
            "payload": {
                "content": content,
                "maxThinkingSeconds": seconds,
            },
        }

    def test_successful_decision_saves_dump_decision_and_minipa(self):
        decision = IntakeDecision(
            verdict=Verdict.WATCH,
            reason="This is an ongoing monitoring request.",
            minipa=MinipaDraft(
                kind=MinipaKind.WATCHER,
                purpose="Monitor arXiv for new papers",
            ),
        )
        with patch("bridge.decide_dump", return_value=decision):
            result = handle_message(self.database, self.message())

        saved_dump = DumpsRepository(self.database).get_by_id(result["dumpId"])
        saved_decisions = DecisionsRepository(self.database).list_for_dump(result["dumpId"])
        saved_minipas = MiniPaRepository(self.database).list_active()
        self.assertEqual(result["decisionStatus"], "complete")
        self.assertEqual(saved_dump.content, "Monitor arXiv for new papers")
        self.assertEqual(len(saved_decisions), 1)
        self.assertEqual(saved_decisions[0].verdict, Verdict.WATCH)
        self.assertEqual(len(saved_minipas), 1)
        self.assertEqual(saved_minipas[0].kind, MinipaKind.WATCHER)

    def test_model_configuration_error_preserves_dump_as_pending(self):
        with patch("bridge.decide_dump", side_effect=ModelConfigurationError("No model config")):
            result = handle_message(self.database, self.message())

        saved_dump = DumpsRepository(self.database).get_by_id(result["dumpId"])
        self.assertEqual(result["decisionStatus"], "pending")
        self.assertEqual(result["analysisError"], "No model config")
        self.assertEqual(saved_dump.content, "Monitor arXiv for new papers")
        self.assertEqual(
            DecisionsRepository(self.database).list_for_dump(result["dumpId"]),
            [],
        )

    def test_rejects_out_of_range_thinking_limit(self):
        with self.assertRaisesRegex(ValueError, "5 to 120"):
            handle_message(self.database, self.message(seconds=121))


if __name__ == "__main__":
    unittest.main()
