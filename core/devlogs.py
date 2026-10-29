"""Small, content-free diagnostics for the optional desktop developer log."""
from datetime import datetime, timezone
from urllib.parse import urlsplit, urlunsplit


def safe_url(value):
    """Keep the useful destination while omitting query and fragment data."""
    try:
        parts = urlsplit(str(value))
        if parts.scheme not in ("http", "https") or not parts.hostname:
            return ""
        host = parts.hostname
        if parts.port:
            host += f":{parts.port}"
        return urlunsplit((parts.scheme, host, parts.path[:500], "", ""))
    except (TypeError, ValueError):
        return ""


def log_event(events, message, level="info", **details):
    event = {
        "category": "devLog",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "level": level,
        "message": str(message)[:500],
    }
    event.update({key: str(value)[:600] for key, value in details.items() if value not in (None, "")})
    events.put_nowait(event)


def task_progress(events, minipa_id, job_id, phase, step, state, *, tool=None, url=None):
    event = {
        "category": "minipaProgress",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "minipaId": int(minipa_id),
        "jobId": int(job_id),
        "phase": str(phase),
        "step": str(step)[:200],
        "state": str(state),
    }
    if tool:
        event["tool"] = str(tool)[:100]
    if url:
        event["url"] = safe_url(url)
    events.put_nowait(event)
