import threading


MAX_READ_PROGRESS = 128


class ReadProgress:
    def __init__(self):
        self.lock = threading.Lock()
        self.requests: dict[int | str, tuple[str, str]] = {}
        self.calls: dict[tuple[str, str], dict] = {}

    def clear_session(self, session_id: str) -> None:
        with self.lock:
            for key in list(self.calls):
                if key[0] == session_id:
                    for request_id in self.calls.pop(key)["requests"]:
                        self.requests.pop(request_id, None)

    def update(self, message: dict) -> dict | None:
        method = message.get("method")
        parameters = message.get("params")
        update = parameters.get("update") if isinstance(parameters, dict) else None
        with self.lock:
            if method == "fs/read_text_file" and isinstance(parameters, dict):
                session_id, path = parameters.get("sessionId"), parameters.get("path")
                request_id = message.get("id")
                if not isinstance(session_id, str) or not isinstance(path, str) or request_id is None:
                    return None
                key = (session_id, path)
                if key not in self.calls and len(self.calls) >= MAX_READ_PROGRESS:
                    return None
                progress = self.calls.setdefault(key, {"requests": set(), "tools": {}})
                progress["requests"].add(request_id)
                self.requests[request_id] = key
            elif method == "session/update" and isinstance(update, dict):
                session_id, tool_id = parameters.get("sessionId"), update.get("toolCallId")
                if update.get("status") in ("completed", "failed"):
                    for key in list(self.calls):
                        progress = self.calls[key]
                        if key[0] == session_id and tool_id in progress["tools"]:
                            for request_id in progress["requests"]:
                                self.requests.pop(request_id, None)
                            self.calls.pop(key)
                    return None
                if update.get("sessionUpdate") != "tool_call" or update.get("kind") != "read":
                    return None
                if "client_view_file" not in str(update.get("title", "")):
                    return None
                locations, metadata = update.get("locations"), update.get("_meta")
                if not isinstance(locations, list) or metadata is not None and not isinstance(metadata, dict):
                    return None
                paths = {location["path"] for location in locations
                         if isinstance(location, dict) and isinstance(location.get("path"), str)}
                if not isinstance(session_id, str) or not isinstance(tool_id, str) or len(paths) != 1:
                    return None
                key = (session_id, paths.pop())
                if key not in self.calls and len(self.calls) >= MAX_READ_PROGRESS:
                    return None
                progress = self.calls.setdefault(key, {"requests": set(), "tools": {}})
                progress["tools"][tool_id] = dict(metadata or {})
            elif method is None:
                key = self.requests.get(message.get("id"))
                if key is None:
                    return None
                progress = self.calls[key]
                result = message.get("result")
                text = result.get("content") if isinstance(result, dict) else None
                if not isinstance(text, str):
                    for request_id in progress["requests"]:
                        self.requests.pop(request_id, None)
                    self.calls.pop(key)
                    return None
                progress["lines"] = text.count("\n") + int(bool(text) and not text.endswith("\n"))
            else:
                return None
            if len(progress["requests"]) != 1 or len(progress["tools"]) != 1 or "lines" not in progress:
                return None
            tool_id, metadata = next(iter(progress["tools"].items()))
            self.calls.pop(key)
            for request_id in progress["requests"]:
                self.requests.pop(request_id, None)
            return {"jsonrpc": "2.0", "method": "session/update", "params": {
                "sessionId": key[0], "update": {
                    "sessionUpdate": "tool_call_update", "toolCallId": tool_id, "status": "completed",
                    "content": [{"type": "content", "content": {
                        "type": "text", "text": f"{progress['lines']} lines",
                    }}],
                    "_meta": {**metadata, "devin-better-acp/hostReadCompleted": True},
                },
            }}
