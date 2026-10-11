from .questions import QuestionCalls

import threading


INFERENCE_NAMES = {"execute": "exec", "search": "grep"}
MAX_TOOL_PROGRESS = 1024


def terminal_meta(update: dict, kind: str | None) -> dict:
    tool_id = update.get("toolCallId")
    ret: dict = {}
    if not isinstance(tool_id, str) or not tool_id:
        return ret
    if isinstance(kind, str) and kind not in ("think", "other", "switch_mode"):
        ret["cognition.ai/inferenceToolName"] = INFERENCE_NAMES.get(kind, kind)
    if kind != "execute":
        return ret
    if update.get("sessionUpdate") == "tool_call":
        ret["terminal_info"] = {"terminal_id": tool_id}
    raw = update.get("rawOutput")
    if update.get("sessionUpdate") != "tool_call_update":
        return ret
    data = raw if isinstance(raw, str) else (
        raw.get("formatted_output") or raw.get("combinedOutput") if isinstance(raw, dict) else None
    )
    if isinstance(data, str) and data:
        ret["terminal_output"] = {"terminal_id": tool_id, "data": data}
    exit_code = raw.get("exitCode", raw.get("exit_code")) if isinstance(raw, dict) else None
    if type(exit_code) is int:
        ret["terminal_exit"] = {"terminal_id": tool_id, "exit_code": exit_code, "signal": None}
    return ret


class ToolPresentation:
    def __init__(self, questions: QuestionCalls):
        self.lock = threading.Lock()
        self.questions = questions
        self.calls: dict[tuple[str, str], dict] = {}

    def update(self, session_id: object, update: dict, permission: bool = False) -> bool:
        tool_id = update.get("toolCallId")
        if not isinstance(session_id, str) or not isinstance(tool_id, str):
            return False
        metadata = update.get("_meta")
        if metadata is not None and not isinstance(metadata, dict):
            return False
        with self.lock:
            key = (session_id, tool_id)
            state = self.calls.get(key, {})
            if len(self.calls) < MAX_TOOL_PROGRESS or key in self.calls:
                state = self.calls.setdefault(key, state)
            if isinstance(update.get("kind"), str):
                state["kind"] = update["kind"]
            mcp = metadata.get("mcp") if isinstance(metadata, dict) else None
            if isinstance(mcp, dict) and all(isinstance(mcp.get(field), str) for field in ("server", "tool")):
                state["mcp"] = mcp
            mcp = state.get("mcp")
            fields = terminal_meta(update, state.get("kind")) if not permission else {}
            changed = False
            if isinstance(mcp, dict):
                title = f"mcp__{mcp['server']}__{mcp['tool']}"
                if update.get("title") != title:
                    update["title"] = title
                    changed = True
                if mcp["server"] == "devin-better-integration" and mcp["tool"] == "ask_user_question":
                    raw = update.get("rawInput")
                    arguments = raw.get("arguments", raw) if isinstance(raw, dict) else None
                    if isinstance(arguments, dict):
                        self.questions.observe(session_id, tool_id, arguments)
                    fields.update(self.questions.metadata(session_id, tool_id))
            if fields:
                metadata = update.setdefault("_meta", {})
                for field, value in fields.items():
                    if field not in metadata:
                        metadata[field] = value
                        changed = True
            if not permission and update.get("sessionUpdate") == "tool_call_update":
                if update.get("status") in ("completed", "failed"):
                    self.calls.pop(key, None)
                    self.questions.finish(session_id, tool_id)
            return changed

    def clear_session(self, session_id: str) -> None:
        with self.lock:
            for key in list(self.calls):
                if key[0] == session_id:
                    self.calls.pop(key)
        self.questions.clear_session(session_id)
