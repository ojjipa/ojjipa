"""Application operations and the control database's transaction boundaries."""

from typing import Optional, Tuple
from datetime import datetime, timezone
import json
from repos.seen_items import SeenItemsRepository
from repos.attention import AttentionRepository
from core.attention.dedup import fingerprint
from core.attention.policy import should_surface
from control_database import ControlDatabase
from core.attention.Finite_state_machine import validate_transition
from repos import (
    ActivityRepository,
    DecisionsRepository,
    DumpsRepository,
    GrandpaActionsRepository,
    HoldQueueRepository,
    MiniPaRepository,
    ReportsRepository,
)
from repos.types import (
    DecisionRecord,
    Dump,
    GrandpaAction,
    HeldItem,
    IntakeDecision,
    Minipa,
    MinipaKind,
    MinipaStatus,
    Report,
    Verdict,
    HoldStatus,
)


def file_report_if_new(
    db: ControlDatabase,
    minipa_id: int,
    source: str,
    item_id: str,
    content: str,
    expires_at: Optional[str] = None,
) -> Optional[Tuple[Report, HeldItem]]:
    if not isinstance(source, str) or not source.strip() or not isinstance(item_id, str) or not item_id.strip():
        raise ValueError('A stable source and item ID are required')
    # Scope deduplication to the MiniPa so independent watches do not suppress each other.
    scope = json.dumps([minipa_id, source], separators=(',', ':'))
    item_key = fingerprint(scope, item_id)
    expires_at = _normalize_expiry(expires_at)

    with db.transaction():
        is_new = SeenItemsRepository(db).record_if_new(scope, item_key)

        if not is_new:
            return None

        report = ReportsRepository(db).create(minipa_id, content)
        held_item = HoldQueueRepository(db).create(report.id, expires_at)

    return report, held_item


def intake_dump(
    db: ControlDatabase,
    text: str,
    decision: IntakeDecision,
) -> Tuple[Dump, DecisionRecord, Optional[Minipa]]:
    """Persist a dump and its already-computed decision as one operation.

    Any model or network call that produces ``decision`` must finish before
    this function is called, so no transaction remains open during that work.
    """
    _validate_intake_decision(decision)
    with db.transaction():
        dump = DumpsRepository(db).create(text)
        minipa = None
        if decision.minipa is not None:
            draft = decision.minipa
            minipa = MiniPaRepository(db).create(
                kind=draft.kind,
                purpose=draft.purpose,
                source=draft.source,
                termination_condition=draft.termination_condition,
                scope=draft.scope,
                config=draft.config,
            )
        decision_record = DecisionsRepository(db).record(
            dump_id=dump.id,
            decision=decision,
            minipa_id=minipa.id if minipa is not None else None,
        )
    return dump, decision_record, minipa


def file_report(
    db: ControlDatabase,
    minipa_id: int,
    content: str,
    hold: bool,
    expires_at: Optional[str] = None,
) -> Tuple[Report, Optional[HeldItem]]:
    """Save a MiniPa report and optionally enqueue it, atomically."""
    expires_at = _normalize_expiry(expires_at)
    with db.transaction():
        report = ReportsRepository(db).create(minipa_id, content)
        held_item = HoldQueueRepository(db).create(report.id, expires_at) if hold else None
    return report, held_item


def record_activity(db: ControlDatabase, category: str) -> None:
    with db.transaction():
        ActivityRepository(db).record_category(category)


def recover_activity(db: ControlDatabase) -> None:
    with db.transaction():
        ActivityRepository(db).recover_open_interval()


def close_activity(db: ControlDatabase) -> None:
    with db.transaction():
        ActivityRepository(db).close_open_interval()


def save_dump(db: ControlDatabase, content: str) -> Dump:
    """Persist an unclassified user dump before any model decision is made."""
    if not isinstance(content, str) or not content.strip():
        raise ValueError("dump content must be a non-empty string")
    with db.transaction():
        return DumpsRepository(db).create(content)


def update_minipa_status(
    db: ControlDatabase,
    minipa_id: int,
    status: MinipaStatus,
) -> Optional[Minipa]:
    with db.transaction():
        repository = MiniPaRepository(db)
        current = repository.get_by_id(minipa_id)
        if current is None:
            return None
        allowed = {
            MinipaStatus.ACTIVE: {MinipaStatus.PAUSED, MinipaStatus.RETIRED},
            MinipaStatus.PAUSED: {MinipaStatus.ACTIVE, MinipaStatus.RETIRED},
            MinipaStatus.RETIRED: set(),
        }
        if status == current.status:
            return current
        if status not in allowed[current.status]:
            raise ValueError(
                f"MiniPa cannot transition from {current.status.value} to {status.value}"
            )
        repository.update_status(minipa_id, status)
        return repository.get_by_id(minipa_id)


def update_hold_status(
    db: ControlDatabase,
    item_id: int,
    status: HoldStatus,
) -> Optional[HeldItem]:
    with db.transaction():
        repository = HoldQueueRepository(db)
        repository.expire_due()
        current = repository.get_by_id(item_id)
        if current is None:
            return None
        if current.status == status:
            return current
        validate_transition(current.status, status)
        repository.update_status(item_id, status)
        return repository.get_by_id(item_id)


def list_held_items(db: ControlDatabase, limit: int = 100) -> list[HeldItem]:
    return HoldQueueRepository(db).list_held(limit)


def count_held_items(db: ControlDatabase) -> int:
    return HoldQueueRepository(db).count_held()


def expire_due_hold_items(db: ControlDatabase) -> int:
    with db.transaction():
        return HoldQueueRepository(db).expire_due()


def _normalize_expiry(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if parsed.tzinfo is None:
            raise ValueError()
        parsed = parsed.astimezone(timezone.utc)
        if parsed <= datetime.now(timezone.utc):
            raise ValueError()
        return parsed.isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    except (AttributeError, TypeError, ValueError):
        raise ValueError('Expiration must be a future ISO timestamp with a timezone') from None


def surface_next_held(db: ControlDatabase, tracker, *, user_requested: bool = False) -> Optional[HeldItem]:
    """Caller serializes tracker access; selection and transition are atomic."""
    with db.transaction():
        repository = HoldQueueRepository(db)
        repository.expire_due()
        preferences = AttentionRepository(db).preferences()
        if not should_surface(category=tracker.category, **tracker.timings(),
                              **preferences, user_requested=user_requested):
            return None
        items = repository.list_held(limit=1)
        if not items:
            return None
        item = items[0]
        validate_transition(item.status, HoldStatus.SURFACED)
        if not repository.update_status(item.id, HoldStatus.SURFACED):
            return None
        result = repository.get_by_id(item.id)
    # Only update the session timer after the transaction commits.
    tracker.mark_surfaced()
    return result


def update_attention_preferences(db: ControlDatabase, changes: dict) -> dict[str, bool]:
    if not isinstance(changes, dict) or any(
        key not in ('focus_enabled', 'auto_surface_enabled') or type(value) is not bool
        for key, value in changes.items()
    ):
        raise ValueError('Attention preferences must be booleans')
    with db.transaction():
        repository = AttentionRepository(db)
        preferences = repository.preferences()
        preferences.update(changes)
        repository.update_preferences(**preferences)
        return preferences


def record_grandpa_action(
    db: ControlDatabase,
    decision: str,
    reason: str,
    report_id: Optional[int] = None,
    minipa_id: Optional[int] = None,
) -> GrandpaAction:
    with db.transaction():
        return GrandpaActionsRepository(db).create(
            decision=decision,
            reason=reason,
            report_id=report_id,
            minipa_id=minipa_id,
        )


def _validate_intake_decision(decision: IntakeDecision) -> None:
    if decision.verdict == Verdict.NOISE:
        if decision.minipa is not None:
            raise ValueError("noise decisions cannot create a MiniPa")
        return

    if decision.minipa is None:
        raise ValueError("task and watch decisions require MiniPa details")

    expected_kind = (
        MinipaKind.TASK if decision.verdict == Verdict.TASK else MinipaKind.WATCHER
    )
    if decision.minipa.kind != expected_kind:
        raise ValueError("MiniPa kind must match the decision verdict")
