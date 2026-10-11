from .server import MAX_LOCAL_BYTES, SOCKET_TIMEOUT_SECONDS

import json
import os
import secrets
import socketserver
import tempfile
import threading
from pathlib import Path
from typing import Callable


class RequestHandler(socketserver.StreamRequestHandler):
    def handle(self) -> None:
        frame = self.rfile.readline(MAX_LOCAL_BYTES + 1)
        request = None
        if len(frame) <= MAX_LOCAL_BYTES and frame.endswith(b"\n"):
            try:
                request = json.loads(frame)
            except (ValueError, UnicodeError, RecursionError):
                pass
        response = self.server.channel.handle_request(request)
        output = json.dumps(response, ensure_ascii=False, separators=(",", ":")).encode() + b"\n"
        if len(output) > MAX_LOCAL_BYTES:
            output = b'{"error":"Client response exceeds the size limit"}\n'
        self.wfile.write(output)
        self.wfile.flush()


class SocketServer(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True
    block_on_close = False

    def __init__(self, path: str, channel: "Channel"):
        self.channel = channel
        super().__init__(path, RequestHandler)


class Channel:
    def __init__(self, send: Callable, answered: Callable):
        self.send = send
        self.answered = answered
        self.lock = threading.Lock()
        self.directory: tempfile.TemporaryDirectory | None = None
        self.server: SocketServer | None = None
        self.thread: threading.Thread | None = None
        self.socket_path: Path | None = None
        self.pending_sessions: dict[int | str, tuple[str, str | None]] = {}
        self.sessions: dict[str, str] = {}
        self.session_tokens: dict[str, str] = {}
        self.requests: dict[str, dict] = {}
        self.closed = False

    def start(self) -> Path:
        if self.closed:
            raise OSError("The local integration is closed")
        if self.socket_path is not None:
            return self.socket_path
        directory = tempfile.TemporaryDirectory(prefix="dba-")
        path = Path(directory.name) / "i.sock"
        try:
            server = SocketServer(str(path), self)
            os.chmod(path, 0o600)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
        except BaseException:
            directory.cleanup()
            raise
        self.directory, self.socket_path = directory, path
        self.server, self.thread = server, thread
        return path

    def prepare(
        self,
        request_id: int | str,
        session_id: str | None,
        allow_elicitation: bool,
    ) -> tuple[Path | None, str | None]:
        if not allow_elicitation:
            return None, None
        path = self.start()
        token = secrets.token_urlsafe(32)
        with self.lock:
            self.pending_sessions[request_id] = (token, session_id)
        return path, token

    def bind(self, request_id: object, session_id: str | None, failed: bool = False) -> None:
        with self.lock:
            pending = self.pending_sessions.pop(request_id, None)
            if pending is None or failed or self.closed:
                return
            token, expected_session = pending
            session_id = session_id if session_id is not None else expected_session
            if session_id is None:
                return
            previous = self.session_tokens.get(session_id)
            self.sessions.pop(previous, None)
            self.sessions[token] = session_id
            self.session_tokens[session_id] = token

    def handle_request(self, request: object) -> dict:
        if not isinstance(request, dict):
            return {"error": "Invalid local integration request"}
        token = request.get("token")
        with self.lock:
            session_id = self.sessions.get(token) if isinstance(token, str) else None
        if session_id is None:
            return {"error": "The local integration session is no longer active"}
        parameters = request.get("params")
        if request.get("operation") != "elicitation/create" or not isinstance(parameters, dict):
            return {"error": "Unsupported local integration operation"}
        if parameters.get("mode") != "form" or not isinstance(parameters.get("message"), str):
            return {"error": "Invalid form elicitation request"}
        if not isinstance(parameters.get("requestedSchema"), dict):
            return {"error": "Invalid form elicitation schema"}
        if "_meta" in parameters and not isinstance(parameters["_meta"], dict):
            return {"error": "Invalid form elicitation metadata"}
        if parameters.get("sessionId", session_id) != session_id:
            return {"error": "The local integration session does not match"}
        parameters = {**parameters, "sessionId": session_id}
        request_id = f"dba-integration-{secrets.token_urlsafe(18)}"
        pending = {"event": threading.Event(), "response": None, "params": parameters, "sessionId": session_id}
        with self.lock:
            if self.closed:
                return {"error": "The local integration is closed"}
            self.requests[request_id] = pending
        self.send({"jsonrpc": "2.0", "id": request_id, "method": "elicitation/create", "params": parameters})
        try:
            if not pending["event"].wait(SOCKET_TIMEOUT_SECONDS):
                return {"error": "The client did not answer the question in time"}
            response = pending["response"]
            if not isinstance(response, dict) or not isinstance(response.get("result"), dict):
                return {"error": "The client interaction failed"}
            return {"result": response["result"]}
        finally:
            with self.lock:
                self.requests.pop(request_id, None)

    def complete(self, message: dict) -> bool:
        with self.lock:
            pending = self.requests.get(message.get("id"))
            if pending is None:
                return False
            if pending["event"].is_set():
                return True
            self.answered(pending["sessionId"], pending["params"], message.get("result"))
            pending["response"] = message
            pending["event"].set()
        return True

    def cancel(self, session_id: str) -> None:
        with self.lock:
            for pending in self.requests.values():
                if pending["sessionId"] == session_id and not pending["event"].is_set():
                    pending["response"] = {"result": {"action": "cancel"}}
                    pending["event"].set()

    def close(self) -> None:
        with self.lock:
            if self.closed:
                return
            self.closed = True
            for pending in self.requests.values():
                pending["event"].set()
            self.sessions.clear()
            self.session_tokens.clear()
            self.pending_sessions.clear()
        if self.server is not None:
            self.server.shutdown()
            self.server.server_close()
        if self.thread is not None:
            self.thread.join(timeout=2)
        if self.directory is not None:
            self.directory.cleanup()
        self.server = self.thread = self.directory = self.socket_path = None
