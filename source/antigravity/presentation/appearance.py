import threading


AGENT_TITLE = "Antigravity (DBA)"
MODE_PRESENTATION = {
    "default": ("Default", "shield", "Default permission prompt flow"),
    "auto_edit": ("Code", "code", "Auto-approve Antigravity file edits; keep command approvals."),
    "yolo": ("Bypass Permissions", "shield-off", "Auto-approve Antigravity tool calls."),
}


def decorate_modes(payload: dict) -> bool:
    groups = []
    modes = payload.get("modes")
    if isinstance(modes, dict) and isinstance(modes.get("availableModes"), list):
        groups.append(modes["availableModes"])
    options = payload.get("configOptions")
    if isinstance(options, list):
        groups.extend(
            option["options"] for option in options
            if isinstance(option, dict) and (option.get("id") == "mode" or option.get("category") == "mode")
            and isinstance(option.get("options"), list)
        )
    ret = False
    for group in groups:
        for option in group:
            if not isinstance(option, dict):
                continue
            value = option.get("value", option.get("id"))
            appearance = MODE_PRESENTATION.get(value) if isinstance(value, str) else None
            if appearance is None:
                continue
            name, icon, description = appearance
            option.update(name=name, description=description)
            metadata = option.setdefault("_meta", {})
            if isinstance(metadata, dict):
                metadata.setdefault("cognition.ai/icon", icon)
            ret = True
    return ret


class SessionAppearance:
    def __init__(self):
        self.lock = threading.Lock()
        self.titles: set[str] = set()

    def title(self, parameters: dict) -> dict | None:
        session_id = parameters.get("sessionId")
        blocks = parameters.get("prompt")
        if not isinstance(session_id, str) or not isinstance(blocks, list):
            return None
        with self.lock:
            if session_id in self.titles:
                return None
        title = next((block["text"].strip().splitlines()[0] for block in blocks
                      if isinstance(block, dict) and block.get("type") == "text"
                      and isinstance(block.get("text"), str) and block["text"].strip()), "")
        if not title:
            return None
        with self.lock:
            if session_id in self.titles:
                return None
            self.titles.add(session_id)
        if len(title) > 80:
            title = title[:80].rsplit(" ", 1)[0]
        return {"jsonrpc": "2.0", "method": "session/update", "params": {
            "sessionId": session_id, "update": {"sessionUpdate": "session_info_update", "title": title},
        }}

    def observe(self, session_id: str) -> None:
        with self.lock:
            self.titles.add(session_id)

    def clear(self, session_id: str) -> None:
        with self.lock:
            self.titles.discard(session_id)
