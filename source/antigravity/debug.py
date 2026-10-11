import json
import os
import threading
import time
from pathlib import Path


DEFAULT_DEBUG_LOG = Path.home() / ".local/state/devin-better-acp/antigravity-acp.jsonl"
LOG_LINE_BYTES = 256 * 1024


def sensitive_log_field(name: object) -> bool:
    if not isinstance(name, str):
        return False
    normalized = "".join(character for character in name.casefold() if character.isalnum())
    return normalized in ("authorization", "headers", "header", "cookie", "setcookie", "env", "environment") or any(
        marker in normalized for marker in ("password", "passwd", "secret", "credential", "privatekey")
    ) or normalized.endswith(("token", "apikey", "accesskey"))


def redact_log_value(value: object) -> object:
    if isinstance(value, dict):
        credential_pair = any(
            isinstance(name, str) and name.casefold() in ("name", "key") and sensitive_log_field(text)
            for name, text in value.items()
        )
        return {
            name: "<redacted>" if sensitive_log_field(name)
            or credential_pair and isinstance(name, str) and name.casefold() in ("value", "defaultvalue")
            else redact_log_value(text)
            for name, text in value.items()
        }
    if isinstance(value, list):
        return [redact_log_value(item) for item in value]
    return value


class DebugLog:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        flags = os.O_CREAT | os.O_APPEND | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(path, flags, 0o600)
        try:
            if hasattr(os, "fchmod"):
                os.fchmod(descriptor, 0o600)
            self.file = os.fdopen(descriptor, "a", encoding="utf-8", buffering=1)
        except BaseException:
            os.close(descriptor)
            raise
        self.lock = threading.Lock()

    def write(self, record: dict) -> None:
        safe_record = redact_log_value(record)
        line = json.dumps({"t": round(time.time(), 3), **safe_record}, ensure_ascii=True, default=str)
        if len(line.encode("ascii")) > LOG_LINE_BYTES:
            message = safe_record.get("msg") if isinstance(safe_record, dict) else None
            parameters = message.get("params") if isinstance(message, dict) else None
            update = parameters.get("update", {}) if isinstance(parameters, dict) else {}
            request_id = message.get("id") if isinstance(message, dict) else None
            line = json.dumps({"t": round(time.time(), 3), "dir": "log", "msg": {
                "event": "frame_truncated",
                "direction": safe_record.get("dir") if isinstance(safe_record, dict) else None,
                "method": message.get("method") if isinstance(message, dict) else None,
                "id": str(request_id)[:80] if request_id is not None else None,
                "sessionUpdate": update.get("sessionUpdate") if isinstance(update, dict) else None,
            }}, separators=(",", ":"))
        with self.lock:
            self.file.write(line + "\n")
