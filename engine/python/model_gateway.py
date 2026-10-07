"""Nebius Token Factory inference for Grandpa's intake decision."""

import json
import os
from typing import Any
from urllib import error, request

from repos.types import IntakeDecision, MinipaDraft, MinipaKind, Verdict

API_URL = "https://api.tokenfactory.nebius.com/v1/chat/completions"


class ModelError(RuntimeError):
    """A configured model could not complete or validate an inference."""


class ModelConfigurationError(ModelError):
    """Required Nebius credentials or model configuration is missing."""


def decide_dump(content: str, timeout_seconds: int) -> IntakeDecision:
    api_key = os.environ.get("NEBIUS_API_KEY", "").strip()
    if not api_key:
        raise ModelConfigurationError(
            "Enter a Nebius API key in OJJIPA Settings or set NEBIUS_API_KEY."
        )

    model = os.environ.get("OJJIPA_GRANDPA_MODEL", "").strip()
    if not model:
        raise ModelConfigurationError(
            "Enter an enabled Grandpa model ID in OJJIPA Settings or set "
            "OJJIPA_GRANDPA_MODEL."
        )

    payload = {
        "model": model,
        "temperature": 0.1,
        "max_tokens": 400,
        "response_format": {"type": "json_object"},
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are Grandpa, an assistant deciding what to do with a "
                    "captured user thought. Return one JSON object only with "
                    "keys verdict, reason, and minipa. verdict must be noise, "
                    "task, or watch. Use noise only for accidental or empty "
                    "content. Use task for a specific one-off piece of work; "
                    "use watch for an ongoing monitoring request. For noise, "
                    "minipa must be null. For task or watch, minipa must be "
                    "an object with kind (task or watcher), purpose, source "
                    "(string or null), termination_condition (string or null), "
                    "scope (string), and config (object). Keep the reason and "
                    "purpose concise. Do not claim to have executed the work."
                ),
            },
            {"role": "user", "content": content},
        ],
    }
    http_request = request.Request(
        API_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )

    try:
        with request.urlopen(http_request, timeout=timeout_seconds) as response:
            response_data = json.loads(response.read().decode("utf-8"))
    except error.HTTPError as exc:
        raise ModelError(f"Nebius inference returned HTTP {exc.code}.") from exc
    except (TimeoutError, error.URLError) as exc:
        if isinstance(exc, error.URLError) and not isinstance(exc.reason, TimeoutError):
            raise ModelError("Could not connect to Nebius Token Factory.") from exc
        raise ModelError(
            f"Grandpa's model did not respond within {timeout_seconds} seconds."
        ) from exc
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ModelError("Nebius returned an invalid inference response.") from exc

    try:
        message_content = response_data["choices"][0]["message"]["content"]
        decoded = json.loads(message_content)
    except (KeyError, IndexError, TypeError, json.JSONDecodeError) as exc:
        raise ModelError("Grandpa returned an invalid decision response.") from exc

    return _parse_decision(decoded)


def _parse_decision(value: Any) -> IntakeDecision:
    if not isinstance(value, dict):
        raise ModelError("Grandpa's decision must be a JSON object.")

    verdict_value = value.get("verdict")
    reason = value.get("reason")
    if not isinstance(reason, str) or not reason.strip():
        raise ModelError("Grandpa's decision is missing a reason.")
    try:
        verdict = Verdict(verdict_value)
    except (ValueError, TypeError) as exc:
        raise ModelError("Grandpa returned an unsupported decision.") from exc

    minipa_value = value.get("minipa")
    if verdict == Verdict.NOISE:
        if minipa_value is not None:
            raise ModelError("Noise decisions cannot include a MiniPa.")
        return IntakeDecision(verdict=verdict, reason=reason.strip())
    if not isinstance(minipa_value, dict):
        raise ModelError("Task and watch decisions must include MiniPa details.")

    expected_kind = (
        MinipaKind.TASK if verdict == Verdict.TASK else MinipaKind.WATCHER
    )
    if minipa_value.get("kind") != expected_kind.value:
        raise ModelError("Grandpa's MiniPa kind does not match its decision.")
    purpose = minipa_value.get("purpose")
    source = minipa_value.get("source")
    termination_condition = minipa_value.get("termination_condition")
    scope = minipa_value.get("scope", "global")
    config = minipa_value.get("config", {})
    if not isinstance(purpose, str) or not purpose.strip():
        raise ModelError("Grandpa's MiniPa is missing its purpose.")
    if source is not None and not isinstance(source, str):
        raise ModelError("Grandpa's MiniPa source must be text or null.")
    if termination_condition is not None and not isinstance(
        termination_condition, str
    ):
        raise ModelError("Grandpa's MiniPa termination condition must be text or null.")
    if not isinstance(scope, str) or not scope.strip():
        raise ModelError("Grandpa's MiniPa scope must be non-empty text.")
    if not isinstance(config, dict):
        raise ModelError("Grandpa's MiniPa config must be a JSON object.")

    return IntakeDecision(
        verdict=verdict,
        reason=reason.strip(),
        minipa=MinipaDraft(
            kind=expected_kind,
            purpose=purpose.strip(),
            source=source,
            termination_condition=termination_condition,
            scope=scope.strip(),
            config=json.dumps(config, separators=(",", ":"), sort_keys=True),
        ),
    )
