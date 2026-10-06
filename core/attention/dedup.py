import hashlib
import json


def fingerprint(source: str, item_id: str) -> str:
    identity = json.dumps(
        [source, item_id],
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()