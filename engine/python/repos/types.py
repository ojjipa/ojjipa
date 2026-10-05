from dataclasses import dataclass
from typing import Optional

try:
    from enum import StrEnum
except ImportError:  # Python versions before 3.11
    from enum import Enum

    class StrEnum(str, Enum):
        def __str__(self) -> str:
            return self.value


class MinipaKind(StrEnum):
    WATCHER = "watcher"
    TASK = "task"


class MinipaStatus(StrEnum):
    ACTIVE = "active"
    PAUSED = "paused"
    RETIRED = "retired"


class Verdict(StrEnum):
    NOISE = "noise"
    TASK = "task"
    WATCH = "watch"


class HoldStatus(StrEnum):
    HELD = "held"
    SURFACED = "surfaced"
    DISMISSED = "dismissed"
    EXPIRED = "expired"


@dataclass(frozen=True)
class Dump:
    id: int
    content: str
    created_at: str


@dataclass(frozen=True)
class Minipa:
    id: int
    kind: MinipaKind
    purpose: str
    source: Optional[str]
    termination_condition: Optional[str]
    scope: str
    status: MinipaStatus
    created_at: str
    updated_at: str


@dataclass(frozen=True)
class MinipaDraft:
    kind: MinipaKind
    purpose: str
    source: Optional[str] = None
    termination_condition: Optional[str] = None
    scope: str = "global"


@dataclass(frozen=True)
class IntakeDecision:
    verdict: Verdict
    reason: Optional[str] = None
    minipa: Optional[MinipaDraft] = None


@dataclass(frozen=True)
class DecisionRecord:
    id: int
    dump_id: int
    verdict: Verdict
    reason: Optional[str]
    minipa_id: Optional[int]
    decided_at: str


@dataclass(frozen=True)
class Report:
    id: int
    minipa_id: int
    content: str
    created_at: str


@dataclass(frozen=True)
class HeldItem:
    id: int
    report_id: int
    status: HoldStatus
    created_at: str
    expires_at: Optional[str]
    surfaced_at: Optional[str]


@dataclass(frozen=True)
class GrandpaAction:
    id: int
    report_id: Optional[int]
    minipa_id: Optional[int]
    decision: str
    reason: str
    decided_at: str
