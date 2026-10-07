import json
import os
import unittest
from unittest.mock import MagicMock
from unittest.mock import patch

from model_gateway import ModelError, _parse_decision, decide_dump
from repos.types import MinipaKind, Verdict


class ParseDecisionTests(unittest.TestCase):
    def test_noise_decision_has_no_minipa(self):
        decision = _parse_decision(
            {"verdict": "noise", "reason": "An accidental capture.", "minipa": None}
        )

        self.assertEqual(decision.verdict, Verdict.NOISE)
        self.assertIsNone(decision.minipa)

    def test_task_decision_creates_task_draft(self):
        decision = _parse_decision(
            {
                "verdict": "task",
                "reason": "This needs a one-time action.",
                "minipa": {
                    "kind": "task",
                    "purpose": "Summarize the attached paper",
                    "source": None,
                    "termination_condition": "Summary is saved",
                    "scope": "global",
                    "config": {"format": "short"},
                },
            }
        )

        self.assertEqual(decision.verdict, Verdict.TASK)
        self.assertIsNotNone(decision.minipa)
        self.assertEqual(decision.minipa.kind, MinipaKind.TASK)
        self.assertEqual(
            json.loads(decision.minipa.config),
            {"format": "short"},
        )

    def test_rejects_minipa_kind_mismatched_with_verdict(self):
        with self.assertRaisesRegex(ModelError, "does not match"):
            _parse_decision(
                {
                    "verdict": "watch",
                    "reason": "This is ongoing.",
                    "minipa": {"kind": "task", "purpose": "Monitor updates"},
                }
            )

    def test_rejects_missing_reason(self):
        with self.assertRaisesRegex(ModelError, "missing a reason"):
            _parse_decision({"verdict": "noise", "minipa": None})

    @patch.dict(
        os.environ,
        {
            "NEBIUS_API_KEY": "test-api-key",
            "OJJIPA_GRANDPA_MODEL": "test/model",
        },
    )
    @patch("model_gateway.request.urlopen")
    def test_request_uses_configured_model_and_thinking_deadline(self, urlopen):
        response = MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps(
            {
                "choices": [
                    {
                        "message": {
                            "content": json.dumps(
                                {
                                    "verdict": "noise",
                                    "reason": "A note to self.",
                                    "minipa": None,
                                }
                            )
                        }
                    }
                ]
            }
        ).encode()
        urlopen.return_value = response

        decision = decide_dump("A note to self.", timeout_seconds=17)

        self.assertEqual(decision.verdict, Verdict.NOISE)
        http_request = urlopen.call_args.args[0]
        self.assertEqual(http_request.full_url, "https://api.tokenfactory.nebius.com/v1/chat/completions")
        self.assertEqual(http_request.get_header("Authorization"), "Bearer test-api-key")
        self.assertEqual(urlopen.call_args.kwargs["timeout"], 17)


if __name__ == "__main__":
    unittest.main()
