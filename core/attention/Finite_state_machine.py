from engine.python.repos.types import HoldStatus

ALLOWED_TRANSITIONS = { 
    HoldStatus.HELD:{
        HoldStatus.SURFACED,
        HoldStatus.DISMISSED,
        HoldStatus.EXPIRED
    },
    HoldStatus.SURFACED: set(),
    HoldStatus.DISMISSED: set(),
    HoldStatus.EXPIRED: set(),
    }

def can_transition(current: HoldStatus, target: HoldStatus) -> bool:
    return target in ALLOWED_TRANSITIONS[current]

def validate_transition(current: HoldStatus, target: HoldStatus) -> None:
    if not can_transition(current, target):
        raise ValueError(
            f"Hold item cannot transition from {current.value} to {target.value}"
        )
