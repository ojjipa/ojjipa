"""Application operations and the control database's transaction boundaries."""

from typing import Optional, Tuple

from control_database import ControlDatabase
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
) -> Tuple[Report, Optional[HeldItem]]:
    """Save a MiniPa report and optionally enqueue it, atomically."""
    with db.transaction():
        report = ReportsRepository(db).create(minipa_id, content)
        held_item = HoldQueueRepository(db).create(report.id) if hold else None
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


def update_minipa_status(
    db: ControlDatabase,
    minipa_id: int,
    status: MinipaStatus,
) -> Optional[Minipa]:
    with db.transaction():
        repository = MiniPaRepository(db)
        if not repository.update_status(minipa_id, status):
            return None
        return repository.get_by_id(minipa_id)


def update_hold_status(
    db: ControlDatabase,
    item_id: int,
    status: HoldStatus,
) -> Optional[HeldItem]:
    with db.transaction():
        repository = HoldQueueRepository(db)
        if not repository.update_status(item_id, status):
            return None
        return repository.get_by_id(item_id)


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
