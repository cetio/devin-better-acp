import json
import os
import secrets
import signal
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import BinaryIO

from .constants import (
    AGENT_TITLE,
    INTEGRATION_TIMEOUT_SECONDS,
    KILL_GRACE_SECONDS,
    MAX_INTEGRATION_FRAME_BYTES,
    MAX_READ_PROGRESS,
    SHIM_COMMAND,
    VERSION,
)
from .debug import DebugLog
from .mcp import INTEGRATION_NAME, install_integration_server, is_integration_server, merge_mcp_servers
from .models import remap_model_option_values
from .presentation import decorate_modes, shlex_join, terminal_meta
from .protocol import ProtocolError, decode_frame, dump, read_frame


class IntegrationRequestHandler(socketserver.StreamRequestHandler):
    def handle(self) -> None:
        frame = self.rfile.readline(MAX_INTEGRATION_FRAME_BYTES + 1)
        if len(frame) > MAX_INTEGRATION_FRAME_BYTES or not frame.endswith(b"\n"):
            response = {"error": "Invalid local integration request"}
        else:
            try:
                request = json.loads(frame)
            except (ValueError, UnicodeError, RecursionError):
                request = None
            response = self.server.bridge.handle_integration_request(request)
        self.wfile.write(json.dumps(response, ensure_ascii=False, separators=(",", ":")).encode() + b"\n")
        self.wfile.flush()


class IntegrationSocketServer(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True
    block_on_close = False

    def __init__(self, socket_path: str, bridge: object):
        self.bridge = bridge
        super().__init__(socket_path, IntegrationRequestHandler)


class Bridge:
    def __init__(
        self,
        server: Path,
        server_args: list[str],
        spoof_zed: bool,
        debug: DebugLog | None = None,
        devin_config: bool = False,
    ):
        self.server = server
        self.server_args = server_args
        self.spoof_zed = spoof_zed
        self.debug = debug
        self.devin_config = devin_config
        self.stopped = threading.Event()
        self.client_closed = threading.Event()
        self.agent_closed = threading.Event()
        self.failure: str | None = None
        self.lock = threading.Lock()
        self.interrupted = False
        self.pending: dict[int | str, str] = {}
        self.pending_sessions: dict[int | str, str] = {}
        self.model_value_maps: dict[str, dict[str, dict[str, str]]] = {}
        self.prompt_sessions: dict[int | str, str] = {}
        self.cancelled_prompts: set[int | str] = set()
        self.read_requests: dict[int | str, tuple[str, str]] = {}
        self.read_calls: dict[tuple[str, str], dict] = {}
        self.tool_kinds: dict[str, str] = {}
        self.titled_sessions: set[str] = set()
        self.form_elicitation = False
        self.integration_script = Path(__file__).with_name("integration.py")
        self.integration_directory: tempfile.TemporaryDirectory | None = None
        self.integration_server: IntegrationSocketServer | None = None
        self.integration_thread: threading.Thread | None = None
        self.integration_socket_path: Path | None = None
        self.pending_integrations: dict[int | str, tuple[str, str | None]] = {}
        self.integration_sessions: dict[str, str] = {}
        self.session_integration_tokens: dict[str, str] = {}
        self.elicitation_requests: dict[str, dict] = {}
        self.frames_up = 0
        self.frames_down = 0
        self.started = time.monotonic()
        self.process: subprocess.Popen | None = None
        self.client_out: BinaryIO | None = None
        self.out_lock = threading.Lock()

    def log(self, direction: str, message: object) -> None:
        if self.debug is not None:
            self.debug.write({"dir": direction, "msg": message})

    def decorate_model_config_options(self, payload: dict, session_id: object) -> bool:
        config_options = payload.get("configOptions")
        if not isinstance(session_id, str) or not isinstance(config_options, list):
            return False
        ret = False
        with self.lock:
            session_maps = self.model_value_maps.setdefault(session_id, {})
            for config_option in config_options:
                if not isinstance(config_option, dict) or config_option.get("category") != "model":
                    continue
                config_id = config_option.get("id")
                if not isinstance(config_id, str):
                    continue
                value_map, changed = remap_model_option_values(config_option)
                session_maps[config_id] = value_map
                ret = ret or changed
        return ret

    def fail(self, message: str) -> None:
        with self.lock:
            if self.failure is None:
                self.failure = message
        self.log("sys", {"event": "failure", "detail": message})
        self.stopped.set()

    def interrupt(self, signum: int, frame: object) -> None:
        self.interrupted = True
        self.stopped.set()

    def send_client(self, frame: bytes) -> None:
        with self.out_lock:
            if self.client_out is not None:
                try:
                    self.client_out.write(frame if frame.endswith(b"\n") else frame + b"\n")
                    self.client_out.flush()
                except (OSError, ValueError):
                    pass

    def start_integration_server(self) -> Path:
        if self.integration_server is not None and self.integration_socket_path is not None:
            return self.integration_socket_path
        if not hasattr(socketserver, "ThreadingUnixStreamServer"):
            raise OSError("Unix domain sockets are unavailable")
        directory = tempfile.TemporaryDirectory(prefix="dba-")
        socket_path = Path(directory.name) / "i.sock"
        try:
            server = IntegrationSocketServer(str(socket_path), self)
            os.chmod(socket_path, 0o600)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
        except BaseException:
            directory.cleanup()
            raise
        self.integration_directory = directory
        self.integration_socket_path = socket_path
        self.integration_server = server
        self.integration_thread = thread
        return socket_path

    def stop_integration_server(self) -> None:
        server = self.integration_server
        if server is not None:
            server.shutdown()
            server.server_close()
        if self.integration_thread is not None:
            self.integration_thread.join(timeout=2)
        if self.integration_directory is not None:
            self.integration_directory.cleanup()
        self.integration_server = None
        self.integration_thread = None
        self.integration_socket_path = None
        self.integration_directory = None

    def handle_integration_request(self, request: object) -> dict:
        if not isinstance(request, dict):
            return {"error": "Invalid local integration request"}
        token = request.get("token")
        operation = request.get("operation")
        parameters = request.get("params")
        with self.lock:
            session_id = self.integration_sessions.get(token) if isinstance(token, str) else None
        if not isinstance(session_id, str):
            return {"error": "The local integration session is no longer active"}
        if operation != "elicitation/create" or not isinstance(parameters, dict):
            return {"error": "Unsupported local integration operation"}
        parameters = dict(parameters)
        if parameters.get("mode") != "form" or not isinstance(parameters.get("message"), str):
            return {"error": "Invalid form elicitation request"}
        if not isinstance(parameters.get("requestedSchema"), dict):
            return {"error": "Invalid form elicitation schema"}
        if "sessionId" in parameters and parameters["sessionId"] != session_id:
            return {"error": "The local integration session does not match"}
        parameters["sessionId"] = session_id
        try:
            return {"result": self.create_elicitation(session_id, parameters)}
        except (TimeoutError, OSError) as error:
            return {"error": str(error) or "The client interaction failed"}

    def create_elicitation(self, session_id: str, parameters: dict) -> dict:
        request_id = f"dba-integration-{secrets.token_urlsafe(18)}"
        pending = {"event": threading.Event(), "response": None}
        with self.lock:
            self.elicitation_requests[request_id] = pending
        request = {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": "elicitation/create",
            "params": parameters,
        }
        self.log("shim", {"event": "integration_elicitation", "sessionId": session_id, "requestId": request_id})
        self.send_client(dump(request))
        try:
            if not pending["event"].wait(INTEGRATION_TIMEOUT_SECONDS):
                raise TimeoutError("The client did not answer the question in time")
            response = pending["response"]
            if not isinstance(response, dict):
                raise OSError("The client returned an invalid question response")
            if "error" in response:
                raise OSError("The client could not display the question")
            result = response.get("result")
            if not isinstance(result, dict):
                raise OSError("The client returned an invalid question response")
            return result
        finally:
            with self.lock:
                self.elicitation_requests.pop(request_id, None)

    def complete_elicitation(self, message: dict) -> bool:
        request_id = message.get("id")
        with self.lock:
            pending = self.elicitation_requests.get(request_id)
            if pending is None:
                return False
            pending["response"] = message
            pending["event"].set()
        result = message.get("result")
        action = result.get("action") if isinstance(result, dict) else None
        self.log("shim", {"event": "integration_elicitation_answered", "action": action})
        return True

    def attach_integration_server(self, parameters: dict, request_id: object) -> bool:
        if (
            not self.form_elicitation
            or not isinstance(request_id, (str, int))
            or not self.integration_script.is_file()
        ):
            return False
        current = parameters.get("mcpServers")
        if isinstance(current, list) and any(
            isinstance(server, dict)
            and server.get("name") == INTEGRATION_NAME
            and not is_integration_server(server, self.integration_script)
            for server in current
        ):
            return False
        try:
            socket_path = self.start_integration_server()
        except OSError:
            self.log("shim", {"event": "integration_server_unavailable"})
            return False
        token = secrets.token_urlsafe(32)
        if not install_integration_server(parameters, socket_path, token, self.integration_script):
            return False
        session_id = parameters.get("sessionId")
        with self.lock:
            self.pending_integrations[request_id] = (token, session_id if isinstance(session_id, str) else None)
        return True

    def status_text(self) -> str:
        process = self.process
        pid = "not started" if process is None else (
            f"pid {process.pid} (running)" if process.poll() is None else f"pid {process.pid} (exited)"
        )
        lines = [
            "**Antigravity (DBA) shim is active** — this reply came from the bridge, not the model.\n\n",
            f"- shim: devin-antigravity-acp {VERSION}\n",
            f"- upstream: `{self.server}` ({pid})\n",
            f"- upstream args: `{shlex_join(self.server_args)}`\n",
            f"- zed spoof: {'on' if self.spoof_zed else 'off'}\n",
            f"- devin config merge: {'on' if self.devin_config else 'off'}\n",
            f"- debug log: `{self.debug.path}`\n" if self.debug else "- debug log: off\n",
            f"- frames: {self.frames_up} client->agent, {self.frames_down} agent->client\n",
            f"- uptime: {time.monotonic() - self.started:.0f}s\n",
        ]
        return "".join(lines)

    def run_shim_command(self, message: dict) -> bool:
        parameters = message.get("params")
        if not isinstance(parameters, dict):
            return False
        blocks = parameters.get("prompt")
        if not isinstance(blocks, list) or len(blocks) != 1 or not isinstance(blocks[0], dict):
            return False
        text = blocks[0].get("text")
        if blocks[0].get("type") != "text" or not isinstance(text, str):
            return False
        command = text.strip().lstrip("/")
        if command != SHIM_COMMAND and not command.startswith(SHIM_COMMAND + " "):
            return False
        session_id = parameters.get("sessionId")
        self.log("shim", {"event": "shim_command", "sessionId": session_id})
        if isinstance(session_id, str):
            self.send_client(dump({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": session_id,
                    "update": {
                        "sessionUpdate": "agent_message_chunk",
                        "content": {"type": "text", "text": self.status_text()},
                    },
                },
            }))
        self.send_client(dump({
            "jsonrpc": "2.0",
            "id": message["id"],
            "result": {"stopReason": "end_turn"},
        }))
        return True

    def emit_session_title(self, message: dict) -> None:
        parameters = message.get("params")
        if not isinstance(parameters, dict):
            return
        session_id = parameters.get("sessionId")
        if not isinstance(session_id, str) or session_id in self.titled_sessions:
            return
        blocks = parameters.get("prompt")
        if not isinstance(blocks, list):
            return
        title = next(
            (block["text"].strip() for block in blocks
             if isinstance(block, dict) and block.get("type") == "text"
             and isinstance(block.get("text"), str) and block["text"].strip()),
            "",
        )
        if not title:
            return
        self.titled_sessions.add(session_id)
        title = title.splitlines()[0]
        if len(title) > 80:
            title = title[:80].rsplit(" ", 1)[0]
        self.log("shim", {"event": "session_info_update", "sessionId": session_id, "title": title})
        self.send_client(dump({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": session_id,
                "update": {
                    "sessionUpdate": "session_info_update",
                    "title": title,
                },
            },
        }))

    def track_read_progress(self, message: dict) -> None:
        method = message.get("method")
        parameters = message.get("params")
        update = parameters.get("update") if isinstance(parameters, dict) else None
        with self.lock:
            if method == "fs/read_text_file" and isinstance(parameters, dict):
                session_id, path = parameters.get("sessionId"), parameters.get("path")
                request_id = message.get("id")
                if not isinstance(session_id, str) or not isinstance(path, str) or request_id is None:
                    return
                key = (session_id, path)
                if key not in self.read_calls and len(self.read_calls) >= MAX_READ_PROGRESS:
                    return
                progress = self.read_calls.setdefault(key, {"requests": set(), "tools": {}})
                progress["requests"].add(request_id)
                self.read_requests[request_id] = key
            elif method == "session/update" and isinstance(update, dict):
                session_id = parameters.get("sessionId")
                tool_call_id = update.get("toolCallId")
                if update.get("status") in ("completed", "failed"):
                    for key in list(self.read_calls):
                        progress = self.read_calls[key]
                        if key[0] == session_id and tool_call_id in progress["tools"]:
                            for request_id in progress["requests"]:
                                self.read_requests.pop(request_id, None)
                            self.read_calls.pop(key)
                    return
                if update.get("sessionUpdate") != "tool_call" or update.get("kind") != "read":
                    return
                if "client_view_file" not in str(update.get("title", "")):
                    return
                locations = update.get("locations")
                metadata = update.get("_meta")
                if not isinstance(locations, list) or metadata is not None and not isinstance(metadata, dict):
                    return
                paths = {
                    location["path"] for location in locations
                    if isinstance(location, dict) and isinstance(location.get("path"), str)
                }
                if not isinstance(session_id, str) or not isinstance(tool_call_id, str) or len(paths) != 1:
                    return
                key = (session_id, paths.pop())
                if key not in self.read_calls and len(self.read_calls) >= MAX_READ_PROGRESS:
                    return
                progress = self.read_calls.setdefault(key, {"requests": set(), "tools": {}})
                progress["tools"][tool_call_id] = dict(update.get("_meta") or {})
            elif method is None:
                key = self.read_requests.get(message.get("id"))
                if key is None:
                    return
                progress = self.read_calls[key]
                result = message.get("result")
                text = result.get("content") if isinstance(result, dict) else None
                if not isinstance(text, str):
                    for request_id in progress["requests"]:
                        self.read_requests.pop(request_id, None)
                    self.read_calls.pop(key)
                    return
                progress["lines"] = text.count("\n") + int(bool(text) and not text.endswith("\n"))
            else:
                return
            if len(progress["requests"]) != 1 or len(progress["tools"]) != 1 or "lines" not in progress:
                return
            tool_call_id, meta = next(iter(progress["tools"].items()))
            lines = progress["lines"]
            self.read_calls.pop(key)
            for request_id in progress["requests"]:
                self.read_requests.pop(request_id, None)
            self.log("shim", {
                "event": "host_read_completed",
                "sessionId": key[0],
                "toolCallId": tool_call_id,
                "lines": lines,
            })
            self.send_client(dump({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": key[0],
                    "update": {
                        "sessionUpdate": "tool_call_update",
                        "toolCallId": tool_call_id,
                        "status": "completed",
                        "content": [{"type": "content", "content": {"type": "text", "text": f"{lines} lines"}}],
                        "_meta": {**meta, "devin-better-acp/hostReadCompleted": True},
                    },
                },
            }))

    def from_client(self, frame: bytes) -> bytes | None:
        message = decode_frame(frame)
        self.frames_up += 1
        if "method" not in message and self.complete_elicitation(message):
            return None
        self.log("c2a", message)
        if message.get("method") == "initialize":
            parameters = message.get("params")
            capabilities = parameters.get("clientCapabilities") if isinstance(parameters, dict) else None
            elicitation = capabilities.get("elicitation") if isinstance(capabilities, dict) else None
            self.form_elicitation = isinstance(elicitation, dict) and isinstance(elicitation.get("form"), dict)
        if "method" not in message:
            self.track_read_progress(message)
        if message.get("method") == "session/prompt":
            if self.run_shim_command(message):
                return None
            self.emit_session_title(message)
        parameters = message.get("params")
        model_value_changed = False
        if message.get("method") == "session/set_config_option" and isinstance(parameters, dict):
            session_id = parameters.get("sessionId")
            config_id = parameters.get("configId")
            model_uid = parameters.get("value")
            if isinstance(session_id, str) and isinstance(config_id, str) and isinstance(model_uid, str):
                with self.lock:
                    provider_value = self.model_value_maps.get(session_id, {}).get(config_id, {}).get(model_uid)
                if provider_value is not None:
                    parameters["value"] = provider_value
                    model_value_changed = provider_value != model_uid
        if "method" in message and message.get("id") is not None:
            with self.lock:
                self.pending[message["id"]] = message["method"]
                if isinstance(parameters, dict):
                    session_id = parameters.get("sessionId")
                    if isinstance(session_id, str):
                        self.pending_sessions[message["id"]] = session_id
                        if message["method"] == "session/prompt":
                            self.prompt_sessions[message["id"]] = session_id
        if message.get("method") == "session/cancel" and isinstance(parameters, dict):
            session_id = parameters.get("sessionId")
            with self.lock:
                cancelled = [
                    request_id for request_id, active_session in self.prompt_sessions.items()
                    if active_session == session_id
                ]
                self.cancelled_prompts.update(cancelled)
            self.log("shim", {"event": "cancel_requested", "sessionId": session_id, "promptIds": cancelled})
        if self.spoof_zed and message.get("method") == "initialize" and isinstance(parameters, dict):
            info = dict(parameters.get("clientInfo") or {})
            info["name"] = "zed"
            info.setdefault("version", VERSION)
            parameters["clientInfo"] = info
            return dump(message)
        request_modified = False
        if self.devin_config and message.get("method") in ("session/new", "session/load"):
            if isinstance(parameters, dict):
                added = merge_mcp_servers(parameters)
                if added:
                    self.log("shim", {"event": "devin_mcp_merge", "added": added})
                    request_modified = True
        if message.get("method") in ("session/new", "session/load") and isinstance(parameters, dict):
            request_modified = self.attach_integration_server(parameters, message.get("id")) or request_modified
        return dump(message) if model_value_changed or request_modified else frame

    def from_agent(self, frame: bytes) -> bytes | None:
        message = decode_frame(frame)
        self.frames_down += 1
        self.log("a2c", message)
        if "method" not in message:
            request_id = message.get("id")
            with self.lock:
                method = self.pending.pop(request_id, None)
                request_session_id = self.pending_sessions.pop(request_id, None)
                session_id = self.prompt_sessions.pop(request_id, None)
                integration = self.pending_integrations.pop(request_id, None)
                cancelled = request_id in self.cancelled_prompts
                self.cancelled_prompts.discard(request_id)
                if integration is not None:
                    token, expected_session_id = integration
                    result = message.get("result")
                    resolved_session_id = result.get("sessionId") if isinstance(result, dict) else None
                    if not isinstance(resolved_session_id, str):
                        resolved_session_id = expected_session_id
                    if isinstance(resolved_session_id, str) and "error" not in message:
                        previous_token = self.session_integration_tokens.get(resolved_session_id)
                        if previous_token is not None:
                            self.integration_sessions.pop(previous_token, None)
                        self.integration_sessions[token] = resolved_session_id
                        self.session_integration_tokens[resolved_session_id] = token
                    else:
                        self.integration_sessions.pop(token, None)
                if method == "session/prompt" and session_id not in self.prompt_sessions.values():
                    for key in list(self.read_calls):
                        if key[0] == session_id:
                            for read_id in self.read_calls.pop(key)["requests"]:
                                self.read_requests.pop(read_id, None)
            if cancelled:
                result = message.get("result")
                error = message.get("error")
                self.log("shim", {
                    "event": "cancel_completed",
                    "sessionId": session_id,
                    "promptId": request_id,
                    "stopReason": result.get("stopReason") if isinstance(result, dict) else None,
                    "errorCode": error.get("code") if isinstance(error, dict) else None,
                })
            result = message.get("result")
            model_decorated = False
            if isinstance(result, dict) and method in (
                "session/new", "session/load", "session/resume", "session/set_config_option",
            ):
                result_session_id = result.get("sessionId")
                if not isinstance(result_session_id, str):
                    result_session_id = request_session_id
                model_decorated = self.decorate_model_config_options(result, result_session_id)
            modes_decorated = isinstance(result, dict) and decorate_modes(result)
            if modes_decorated:
                self.log("shim", {"event": "mode_presentation", "requestId": request_id})
            if method == "initialize":
                if isinstance(result, dict):
                    info = dict(result.get("agentInfo") or {})
                    info["title"] = AGENT_TITLE
                    version = info.get("version")
                    info["version"] = version + f"+devin-shim-{VERSION}" if isinstance(version, str) else VERSION
                    result["agentInfo"] = info
                    if self.devin_config:
                        meta = result.setdefault("_meta", {})
                        if isinstance(meta, dict):
                            meta.setdefault("mcpConfigPath", str(Path.home() / ".config/devin/mcp_config.json"))
                    return dump(message)
            return dump(message) if model_decorated or modes_decorated else frame
        if message.get("method") == "fs/read_text_file":
            self.track_read_progress(message)
        if message.get("method") == "session/update":
            update = (message.get("params") or {}).get("update")
            if not isinstance(update, dict):
                return frame
            kind = update.get("sessionUpdate")
            if kind == "config_option_update":
                session_id = message["params"].get("sessionId")
                model_decorated = self.decorate_model_config_options(update, session_id)
                modes_decorated = decorate_modes(update)
                if modes_decorated:
                    self.log("shim", {"event": "mode_presentation", "sessionId": session_id})
                if model_decorated or modes_decorated:
                    return dump(message)
            content = update.get("content")
            if kind == "agent_message_chunk" and isinstance(content, dict) and content.get("type") == "text":
                if content.get("text") == "The request was cancelled by the client.":
                    session_id = message["params"].get("sessionId")
                    with self.lock:
                        cancelled = any(
                            self.prompt_sessions.get(request_id) == session_id
                            for request_id in self.cancelled_prompts
                        )
                    if cancelled:
                        self.log("shim", {"event": "cancellation_message_suppressed", "sessionId": session_id})
                        return None
            if kind == "tool_call":
                tool_call_id = update.get("toolCallId")
                if isinstance(tool_call_id, str) and isinstance(update.get("kind"), str):
                    self.tool_kinds[tool_call_id] = update["kind"]
            meta = terminal_meta(update, self.tool_kinds)
            changed = False
            if meta is not None:
                container = update.setdefault("_meta", {})
                if isinstance(container, dict):
                    for key, value in meta.items():
                        if key not in container:
                            container[key] = value
                            changed = True
                    if changed:
                        self.log("shim", {
                            "event": "terminal_meta",
                            "toolCallId": update.get("toolCallId"),
                            "fields": list(meta),
                        })
            if (
                kind == "tool_call"
                and update.get("kind") == "read"
                and "client_view_file" in str(update.get("title", ""))
            ):
                self.send_client(dump(message) if changed else frame)
                self.track_read_progress(message)
                return None
            if kind == "tool_call_update" and update.get("status") in ("completed", "failed"):
                self.track_read_progress(message)
            if changed:
                return dump(message)
            if kind == "available_commands_update":
                commands = update.setdefault("availableCommands", [])
                if isinstance(commands, list) and not any(
                    isinstance(command, dict) and command.get("name") == SHIM_COMMAND for command in commands
                ):
                    commands.append({
                        "name": SHIM_COMMAND,
                        "description": "Show Devin shim bridge status (answered locally, no model call)",
                        "_meta": {"cognition.ai/category": "System"},
                    })
                    self.log("shim", {
                        "event": "command_merged",
                        "command": SHIM_COMMAND,
                        "commands": [c.get("name") for c in commands if isinstance(c, dict)],
                    })
                    return dump(message)
        return frame

    def copy_client(self, process: subprocess.Popen) -> None:
        try:
            with os.fdopen(os.dup(sys.stdin.fileno()), "rb") as source:
                while (frame := read_frame(source)) is not None:
                    forwarded = self.from_client(frame)
                    if forwarded is not None:
                        process.stdin.write(forwarded if forwarded.endswith(b"\n") else forwarded + b"\n")
                        process.stdin.flush()
        except ProtocolError as error:
            self.fail(str(error))
        except (OSError, ValueError):
            if process.poll() is None:
                self.fail("client transport closed unexpectedly")
        finally:
            self.client_closed.set()
            try:
                process.stdin.close()
            except OSError:
                pass

    def copy_agent(self, process: subprocess.Popen) -> None:
        try:
            while (frame := read_frame(process.stdout)) is not None:
                forwarded = self.from_agent(frame)
                if forwarded is not None:
                    self.send_client(forwarded if forwarded.endswith(b"\n") else forwarded + b"\n")
        except ProtocolError as error:
            self.fail(str(error))
        except (OSError, ValueError):
            self.fail("agent transport closed unexpectedly")
        finally:
            self.agent_closed.set()
            self.stopped.set()

    def drain_stderr(self, process: subprocess.Popen) -> None:
        while chunk := process.stderr.read(8192):
            if self.debug is not None:
                self.debug.write({"dir": "err", "bytes": len(chunk)})

    def run(self) -> int:
        try:
            process = subprocess.Popen(
                [str(self.server), *self.server_args],
                cwd=self.server.parent,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                start_new_session=os.name == "posix",
            )
        except OSError as error:
            print(f"Antigravity ACP shim: cannot start server (errno {error.errno}).", file=sys.stderr)
            return 1
        self.process = process
        self.client_out = os.fdopen(os.dup(sys.stdout.fileno()), "wb")
        self.log("sys", {
            "event": "spawn",
            "server": str(self.server),
            "args": self.server_args,
            "pid": process.pid,
            "spoofZed": self.spoof_zed,
            "devinConfig": self.devin_config,
        })
        client = threading.Thread(target=self.copy_client, args=(process,), daemon=True)
        agent = threading.Thread(target=self.copy_agent, args=(process,), daemon=True)
        stderr = threading.Thread(target=self.drain_stderr, args=(process,), daemon=True)
        previous = {signum: signal.signal(signum, self.interrupt) for signum in (signal.SIGINT, signal.SIGTERM)}
        client.start()
        agent.start()
        stderr.start()
        deadline = None
        try:
            while not self.stopped.wait(0.05) and process.poll() is None:
                if self.client_closed.is_set():
                    if deadline is None:
                        deadline = time.monotonic() + KILL_GRACE_SECONDS
                    elif time.monotonic() >= deadline:
                        break
            if self.agent_closed.is_set() and self.failure is None:
                try:
                    process.wait(timeout=KILL_GRACE_SECONDS)
                except subprocess.TimeoutExpired:
                    self.fail("server closed stdout without exiting")
            code = process.poll()
        finally:
            stop_child(process)
            self.stop_integration_server()
            agent.join(timeout=KILL_GRACE_SECONDS)
            stderr.join(timeout=KILL_GRACE_SECONDS)
            self.log("sys", {"event": "exit", "code": process.poll()})
            for signum, handler in previous.items():
                signal.signal(signum, handler)
        if self.failure is not None:
            print(f"Antigravity ACP shim: {self.failure}.", file=sys.stderr)
            return 1
        if code not in (None, 0):
            print(f"Antigravity ACP shim: server exited with code {code}.", file=sys.stderr)
            return 1
        if code is None and not self.client_closed.is_set() and not self.interrupted:
            print("Antigravity ACP shim: server stopped unexpectedly.", file=sys.stderr)
            return 1
        return 0


def signal_child(process: subprocess.Popen, force: bool) -> None:
    try:
        if os.name == "posix":
            os.killpg(process.pid, signal.SIGKILL if force else signal.SIGTERM)
        elif process.poll() is None:
            if force:
                process.kill()
            else:
                process.terminate()
    except ProcessLookupError:
        pass


def stop_child(process: subprocess.Popen) -> None:
    signal_child(process, False)
    try:
        process.wait(timeout=KILL_GRACE_SECONDS)
    except subprocess.TimeoutExpired:
        signal_child(process, True)
        process.wait()
    finally:
        signal_child(process, True)
