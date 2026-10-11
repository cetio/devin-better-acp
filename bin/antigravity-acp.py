#!/usr/bin/env python3

import argparse
import json
import os
import platform
import re
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import BinaryIO


VERSION = "0.3.0"
DEFAULT_SERVER = Path.home() / ".local/opt/agy-acp/current/agy_acp_server.par"
DEFAULT_DEBUG_LOG = Path.home() / ".local/state/devin-better-acp/antigravity-acp.jsonl"
DEFAULT_ICON_URL = "https://cdn.jsdelivr.net/gh/cetio/devin-better-acp@main/images/antigravity-acp.svg"
MAX_FRAME_BYTES = 16 * 1024 * 1024
KILL_GRACE_SECONDS = 2
LOG_LINE_BYTES = 256 * 1024
MAX_READ_PROGRESS = 128
SHIM_COMMAND = "devin-shim"
AGENT_TITLE = "Antigravity (DBA)"


class ProtocolError(ValueError):
    pass


def read_frame(stream: BinaryIO, limit: int = MAX_FRAME_BYTES) -> bytes | None:
    while True:
        ret = stream.readline(limit + 1)
        if len(ret) > limit:
            raise ProtocolError("JSON-RPC frame exceeded the size limit")
        if not ret or ret.strip():
            return ret or None


def decode_frame(frame: bytes) -> dict:
    try:
        ret = json.loads(frame)
    except (ValueError, UnicodeError, RecursionError):
        raise ProtocolError("invalid JSON-RPC frame") from None
    if not isinstance(ret, dict) or ret.get("jsonrpc") != "2.0":
        raise ProtocolError("invalid JSON-RPC envelope")
    if "method" in ret:
        if not isinstance(ret["method"], str) or not ret["method"]:
            raise ProtocolError("invalid JSON-RPC method")
    elif "id" not in ret or ("result" in ret) == ("error" in ret):
        raise ProtocolError("invalid JSON-RPC response")
    if "id" in ret and ret["id"] is not None and type(ret["id"]) not in (int, str):
        raise ProtocolError("invalid JSON-RPC identifier")
    return ret


def dump(message: dict) -> bytes:
    return json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode() + b"\n"


def strip_json_comments(text: str) -> str:
    ret: list[str] = []
    index = 0
    in_string = False
    escaped = False
    while index < len(text):
        character = text[index]
        if in_string:
            ret.append(character)
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                in_string = False
            index += 1
            continue
        if character == '"':
            in_string = True
        elif character == "/" and index + 1 < len(text):
            following = text[index + 1]
            if following == "/":
                end = text.find("\n", index)
                index = len(text) if end < 0 else end
                continue
            if following == "*":
                end = text.find("*/", index + 2)
                index = len(text) if end < 0 else end + 2
                continue
        ret.append(character)
        index += 1
    return "".join(ret)


def load_devin_config(path: Path) -> dict:
    try:
        ret = json.loads(strip_json_comments(path.read_text(encoding="utf-8")))
    except (OSError, ValueError, UnicodeError):
        return {}
    return ret if isinstance(ret, dict) else {}


def name_value_pairs(value: object) -> list[dict]:
    if not isinstance(value, dict):
        return []
    return [
        {"name": name, "value": text if isinstance(text, str) else str(text)}
        for name, text in value.items()
        if isinstance(name, str)
    ]


def to_acp_server(name: str, entry: object) -> dict | None:
    if not isinstance(name, str) or not name or not isinstance(entry, dict):
        return None
    if entry.get("disabled") is True or entry.get("enabled") is False:
        return None
    url = entry.get("url") or entry.get("serverUrl")
    if isinstance(url, str) and url:
        ret = {"type": "http", "name": name, "url": url}
        headers = name_value_pairs(entry.get("headers"))
        if headers:
            ret["headers"] = headers
        return ret
    command = entry.get("command")
    if not isinstance(command, str) or not command:
        return None
    arguments = entry.get("args")
    return {
        "name": name,
        "command": command,
        "args": [argument for argument in arguments if isinstance(argument, str)]
        if isinstance(arguments, list)
        else [],
        "env": name_value_pairs(entry.get("env")),
    }


def devin_mcp_servers(cwd: object) -> list[dict]:
    if not isinstance(cwd, str) or not cwd:
        return []
    workspace = Path(cwd)
    sources = [
        workspace / ".devin/mcp_config.local.json",
        workspace / ".devin/mcp_config.json",
        workspace / ".devin/config.json",
        Path.home() / ".config/devin/mcp_config.json",
        Path.home() / ".config/devin/config.json",
    ]
    ret: dict[str, dict] = {}
    for source in sources:
        servers = load_devin_config(source).get("mcpServers")
        if not isinstance(servers, dict):
            continue
        for name, entry in servers.items():
            server = to_acp_server(name, entry)
            if server is not None:
                ret.setdefault(server["name"], server)
    return list(ret.values())


def merge_mcp_servers(parameters: dict) -> list[str]:
    current = parameters.get("mcpServers")
    existing = {
        server.get("name") for server in current if isinstance(server, dict)
    } if isinstance(current, list) else set()
    added = [server for server in devin_mcp_servers(parameters.get("cwd")) if server["name"] not in existing]
    if not added:
        return []
    parameters["mcpServers"] = [*(current if isinstance(current, list) else []), *added]
    return [server["name"] for server in added]


INFERENCE_NAMES = {
    "execute": "exec",
    "search": "grep",
}
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
            presentation = MODE_PRESENTATION.get(value) if isinstance(value, str) else None
            if presentation is None:
                continue
            name, icon, description = presentation
            if option.get("name") != name or option.get("description") != description:
                option.update(name=name, description=description)
                ret = True
            meta = option.setdefault("_meta", {})
            if isinstance(meta, dict) and "cognition.ai/icon" not in meta:
                meta["cognition.ai/icon"] = icon
                ret = True
    return ret


def terminal_meta(update: dict, tool_kinds: dict) -> dict | None:
    tool_call_id = update.get("toolCallId")
    if not isinstance(tool_call_id, str) or not tool_call_id:
        return None
    ret: dict[str, object] = {}
    kind = update.get("kind") or tool_kinds.get(tool_call_id)
    if isinstance(kind, str) and kind not in ("think", "other", "switch_mode"):
        ret["cognition.ai/inferenceToolName"] = INFERENCE_NAMES.get(kind, kind)
    if update.get("sessionUpdate") == "tool_call":
        if update.get("kind") == "execute":
            ret["terminal_info"] = {"terminal_id": tool_call_id}
    elif update.get("sessionUpdate") == "tool_call_update":
        raw = update.get("rawOutput")
        if isinstance(raw, str):
            if raw and tool_kinds.get(tool_call_id) == "execute":
                ret["terminal_output"] = {"terminal_id": tool_call_id, "data": raw}
        elif isinstance(raw, dict):
            data = raw.get("formatted_output") or raw.get("combinedOutput")
            if isinstance(data, str) and data:
                ret["terminal_output"] = {"terminal_id": tool_call_id, "data": data}
            exit_code = raw.get("exitCode", raw.get("exit_code"))
            if isinstance(exit_code, int):
                ret["terminal_exit"] = {
                    "terminal_id": tool_call_id,
                    "exit_code": exit_code,
                    "signal": None,
                }
    return ret or None


def shlex_join(arguments: list[str]) -> str:
    ret = " ".join(
        argument if all(char.isalnum() or char in "-._/=" for char in argument) else repr(argument)
        for argument in arguments
    )
    return ret or "(none)"


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


def devin_model_uid(value: object) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    aliases = {
        "gemini-pro-agent": "gemini-3-1-pro-high",
        "claude-sonnet-4-6": "claude-sonnet-4-6-thinking",
    }
    if value in aliases:
        return aliases[value]
    gemini_flash = re.fullmatch(r"gemini-3(?:\.0)?-flash-(minimal|low|medium|high)", value)
    if gemini_flash is not None:
        return f"MODEL_GOOGLE_GEMINI_3_0_FLASH_{gemini_flash.group(1).upper()}"
    return re.sub(r"(?<=\d)\.(?=\d)", "-", value)


def model_option_entries(options: list) -> list[dict]:
    ret: list[dict] = []
    for option in options:
        if not isinstance(option, dict):
            continue
        nested = option.get("options")
        if "group" in option and isinstance(nested, list):
            ret.extend(model_option_entries(nested))
        else:
            ret.append(option)
    return ret


def remap_model_option_values(config_option: dict) -> tuple[dict[str, str], bool]:
    options = config_option.get("options")
    if not isinstance(options, list):
        return {}, False
    entries = model_option_entries(options)
    provider_values = {
        option["value"] for option in entries
        if isinstance(option.get("value"), str)
    }
    aliases: dict[str, set[str]] = {}
    for option in entries:
        provider_value = option.get("value")
        model_uid = devin_model_uid(provider_value)
        if model_uid is not None and model_uid != provider_value:
            aliases.setdefault(model_uid, set()).add(provider_value)
    ret: dict[str, str] = {}
    for model_uid, provider_candidates in aliases.items():
        if len(provider_candidates) == 1 and model_uid not in provider_values:
            ret[model_uid] = next(iter(provider_candidates))
    provider_to_devin = {provider_value: model_uid for model_uid, provider_value in ret.items()}
    changed = False
    for option in entries:
        provider_value = option.get("value")
        model_uid = provider_to_devin.get(provider_value)
        if model_uid is not None:
            option["value"] = model_uid
            changed = True
    current_value = config_option.get("currentValue")
    model_uid = provider_to_devin.get(current_value)
    if model_uid is not None:
        config_option["currentValue"] = model_uid
        changed = True
    return ret, changed


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
        self.log("c2a", message)
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
        if self.devin_config and message.get("method") in ("session/new", "session/load"):
            if isinstance(parameters, dict):
                added = merge_mcp_servers(parameters)
                if added:
                    self.log("shim", {"event": "devin_mcp_merge", "added": added})
                    return dump(message)
        return dump(message) if model_value_changed else frame

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
                cancelled = request_id in self.cancelled_prompts
                self.cancelled_prompts.discard(request_id)
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
            decorated = model_decorated or modes_decorated
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
            return dump(message) if decorated else frame
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
                        self.log("shim", {"event": "terminal_meta", "toolCallId": update.get("toolCallId"), "fields": list(meta)})
            if kind == "tool_call" and update.get("kind") == "read" and "client_view_file" in str(update.get("title", "")):
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


def registry_entry(
    server: Path,
    server_args: list[str],
    spoof_zed: bool,
    icon_url: str,
    debug_log: Path | None,
    devin_config: bool,
) -> dict:
    system = {"darwin": "darwin", "linux": "linux", "win32": "windows"}.get(sys.platform)
    architecture = {"amd64": "x86_64", "x86_64": "x86_64", "arm64": "aarch64", "aarch64": "aarch64"}.get(
        platform.machine().lower(),
    )
    if system is None or architecture is None:
        raise ValueError("this platform is not supported by the ACP registry")
    arguments = [str(Path(__file__).resolve()), "--server", str(server)]
    if spoof_zed:
        arguments.append("--spoof-zed")
    if debug_log is not None:
        arguments.append("--debug")
        if debug_log != DEFAULT_DEBUG_LOG:
            arguments.extend(["--debug-log", str(debug_log)])
    if devin_config:
        arguments.append("--devin-config")
    if server_args:
        arguments.extend(["--", *server_args])
    return {
        "id": "devin-better-antigravity",
        "name": AGENT_TITLE,
        "version": VERSION,
        "description": "Antigravity ACP bridge for Devin Desktop with optional Zed client compatibility.",
        "authors": ["cet"],
        "license": "MIT",
        "icon": icon_url,
        "distribution": {
            "binary": {
                f"{system}-{architecture}": {
                    "archive": "",
                    "cmd": str(Path(sys.executable).absolute()),
                    "args": arguments,
                },
            },
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Bridge Antigravity ACP to Devin Desktop over JSON-RPC stdio.")
    parser.add_argument(
        "--server",
        type=Path,
        default=DEFAULT_SERVER,
        help="Antigravity ACP server executable",
    )
    parser.add_argument("--spoof-zed", action="store_true", help="send clientInfo.name=zed only to Antigravity")
    parser.add_argument("--debug", action="store_true", help="log redacted, bounded ACP traffic and stderr counts to a private file")
    parser.add_argument(
        "--debug-log",
        type=Path,
        help=f"debug log path, default {DEFAULT_DEBUG_LOG} (implies --debug)",
    )
    parser.add_argument(
        "--devin-config",
        action="store_true",
        help="merge MCP servers from .devin and ~/.config/devin into session/new and session/load",
    )
    parser.add_argument(
        "--registry-entry",
        action="store_true",
        help="print a Desktop registry entry",
    )
    parser.add_argument(
        "--icon-url",
        default=DEFAULT_ICON_URL,
        help="https URL of the SVG icon used in the registry entry",
    )
    parser.add_argument("--version", action="version", version=VERSION)
    parser.add_argument("server_args", nargs=argparse.REMAINDER, help="arguments forwarded after -- to Antigravity")
    arguments = parser.parse_args()
    server = arguments.server.expanduser().absolute()
    server_args = arguments.server_args
    if server_args[:1] == ["--"]:
        server_args = server_args[1:]
    debug_log = arguments.debug_log.expanduser() if arguments.debug_log else (
        DEFAULT_DEBUG_LOG if arguments.debug else None
    )
    if arguments.registry_entry:
        try:
            print(json.dumps(registry_entry(
                server,
                server_args,
                arguments.spoof_zed,
                arguments.icon_url,
                debug_log,
                arguments.devin_config,
            ), indent=2))
        except ValueError as error:
            parser.error(str(error))
        return 0
    debug = None
    if debug_log is not None:
        try:
            debug = DebugLog(debug_log)
        except OSError as error:
            print(f"Antigravity ACP shim: cannot open debug log (errno {error.errno}).", file=sys.stderr)
            return 1
    return Bridge(server.resolve(), server_args, arguments.spoof_zed, debug, arguments.devin_config).run()


if __name__ == "__main__":
    raise SystemExit(main())
