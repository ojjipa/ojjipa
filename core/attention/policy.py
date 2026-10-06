MIN_STABLE_SECONDS = 60.0
MAX_ACTIVITY_AGE_SECONDS = 15.0
MIN_SURFACE_INTERVAL_SECONDS = 60.0
def should_surface(
    category: str,
    stable_seconds: float,
    activity_age_seconds: float,
    seconds_since_last_surface: float,
    focus_enabled: bool,
    user_requested: bool,
    auto_surface_enabled: bool,
) -> bool:
    if user_requested:
        return True
    if not auto_surface_enabled or focus_enabled:
        return False
    if not 0 <= activity_age_seconds < MAX_ACTIVITY_AGE_SECONDS:
        return False
    if category != "messaging":
        return False
    if not stable_seconds >= MIN_STABLE_SECONDS:
        return False
    if not seconds_since_last_surface >= MIN_SURFACE_INTERVAL_SECONDS:
        return False
    return True