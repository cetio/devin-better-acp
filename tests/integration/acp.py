import argparse
import collections
import json
import os
import platform
import queue
import shlex
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MCP_SERVER = """
import json
import sys
from pathlib import Path


def send(message):
    sys.stdout.write(json.dumps(message) + "\\n")
    sys.stdout.flush()


for line in sys.stdin:
    message = json.loads(line)
    if "id" not in message:
        continue
    method = message.get("method")
    if method == "initialize":
        result = {
            "protocolVersion": message["params"]["protocolVersion"],
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "shim-smoke", "version": "1.0.0"},
        }
    elif method == "tools/list":
        result = {"tools": [{
            "name": "echo_marker",
            "description": "Echo a marker for a local ACP transport test; no external side effects.",
            "inputSchema": {
                "type": "object",
                "properties": {"marker": {"type": "string"}},
                "required": ["marker"],
                "additionalProperties": False,
            },
        }]}
    elif method == "tools/call" and message["params"]["name"] == "echo_marker":
        marker = message["params"]["arguments"]["marker"]
        Path(sys.argv[1]).write_text(marker)
        result = {"content": [{"type": "text", "text": marker}], "isError": False}
    elif method == "ping":
        result = {}
    else:
        send({"jsonrpc": "2.0", "id": message["id"], "error": {"code": -32601, "message": "Unsupported method"}})
        continue
    send({"jsonrpc": "2.0", "id": message["id"], "result": result})
"""


class SmokeError(RuntimeError):
    pass


class Client:
    def __init__(self, launch: dict, workspace: Path, command: str):
        self.workspace = workspace
        self.command = command
        self.messages = queue.Queue(maxsize=512)
        self.events = collections.Counter()
        self.tools = {}
        self.text = ""
        self.permissions = 0
        self.denied = 0
        self.sequence = 0
        self.process = subprocess.Popen(
            [launch["cmd"], *launch.get("args", [])],
            cwd=workspace,
            env={**os.environ, **launch.get("env", {})},
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self.reader = threading.Thread(target=self.read_stdout, daemon=True)
        self.reader.start()

    def read_stdout(self):
        try:
            for line in self.process.stdout:
                if len(line) > 16 * 1024 * 1024:
                    break
                self.messages.put(json.loads(line))
        except (ValueError, OSError):
            pass
        finally:
            self.messages.put(None)

    def send(self, message):
        self.process.stdin.write(json.dumps(message).encode() + b"\n")
        self.process.stdin.flush()

    def request(self, method: str, parameters: dict, timeout: float = 90) -> dict:
        self.sequence += 1
        request_id = self.sequence
        self.send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": parameters})
        deadline = time.monotonic() + timeout
        while True:
            try:
                message = self.messages.get(timeout=max(0.001, deadline - time.monotonic()))
            except queue.Empty:
                raise SmokeError(f"Timed out waiting for {method}") from None
            if message is None:
                raise SmokeError("ACP bridge closed before the request completed")
            if "method" in message:
                self.handle(message)
            elif message.get("id") == request_id:
                if "error" in message:
                    error = message["error"]
                    if "auth" in str(error.get("message", "")).lower():
                        raise SmokeError("Antigravity requires its normal sign-in; no authentication changes made")
                    raise SmokeError(f"{method} returned RPC error {error.get('code')}; provider detail redacted")
                return message["result"]

    def handle(self, message: dict):
        method = message["method"]
        parameters = message.get("params", {})
        if method == "session/update":
            update = parameters["update"]
            variant = update.get("sessionUpdate", "unknown")
            self.events[variant] += 1
            if variant in ("tool_call", "tool_call_update"):
                tool = self.tools.setdefault(update["toolCallId"], {})
                tool.update(update)
            elif variant == "agent_message_chunk" and update.get("content", {}).get("type") == "text":
                self.text = (self.text + update["content"].get("text", ""))[-65536:]
            return
        if "id" not in message:
            return
        if method == "session/request_permission":
            call = parameters["toolCall"]
            tool = {**self.tools.get(call["toolCallId"], {}), **call}
            allowed = self.allow_tool(tool)
            choice = next((
                option for option in parameters["options"]
                if option["kind"] == ("allow_once" if allowed else "reject_once")
            ), None)
            self.permissions += 1
            self.denied += not allowed
            outcome = {"outcome": "cancelled"} if choice is None else {
                "outcome": "selected", "optionId": choice["optionId"],
            }
            self.send({"jsonrpc": "2.0", "id": message["id"], "result": {"outcome": outcome}})
            return
        if method in ("fs/read_text_file", "fs/write_text_file"):
            path = Path(parameters["path"]).resolve()
            if path != self.workspace / "smoke.txt":
                self.reject(message["id"])
                return
            if method == "fs/read_text_file":
                lines = path.read_text().splitlines(keepends=True)
                start = max(0, (parameters.get("line") or 1) - 1)
                limit = parameters.get("limit") or len(lines)
                result = {"content": "".join(lines[start:start + limit])}
            elif parameters.get("content") == "ACP_FILE_OK\n":
                path.write_text(parameters["content"])
                result = {}
            else:
                self.reject(message["id"])
                return
            self.send({"jsonrpc": "2.0", "id": message["id"], "result": result})
            return
        self.reject(message["id"])

    def allow_tool(self, tool: dict) -> bool:
        arguments = tool.get("rawInput", {})
        encoded = json.dumps(arguments)
        if "echo_marker" in str(tool.get("title", "")) and "ACP_MCP_OK" in encoded:
            return True
        if isinstance(arguments, dict):
            if tool.get("kind") == "execute" and any(value == self.command for value in arguments.values()):
                return True
            paths = [
                value for key, value in arguments.items()
                if key.lower().replace("_", "") in ("path", "filepath", "absolutepath", "targetfile")
                and isinstance(value, str)
            ]
            if paths and tool.get("kind") in ("read", "edit"):
                return all(
                    (self.workspace / path).resolve() == self.workspace / "smoke.txt" for path in paths
                )
        return False

    def reject(self, request_id):
        self.send({
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {"code": -32601, "message": "Operation is outside this isolated smoke test"},
        })

    def close(self):
        self.process.stdin.close()
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            self.process.wait(timeout=10)
        self.reader.join(timeout=2)
        self.process.stdout.close()
        self.process.stderr.close()


def model_values(options: list) -> list[str]:
    ret = []
    for option in options:
        if isinstance(option.get("value"), str):
            ret.append(option["value"])
        if isinstance(option.get("options"), list):
            ret.extend(model_values(option["options"]))
    return ret


def run(launch: dict) -> dict:
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="acp-shim-live-") as directory:
        workspace = Path(directory)
        sample = workspace / "smoke.txt"
        sample.write_text("ACP_FILE_OLD\n")
        mcp = workspace / "mcp.py"
        mcp.write_text(MCP_SERVER)
        log = workspace / "mcp-called.txt"
        command_file = workspace / "command.txt"
        command = f"printf ACP_COMMAND_OK > {shlex.quote(str(command_file))}"
        client = Client(launch, workspace, command)
        try:
            initialization = client.request("initialize", {
                "protocolVersion": 1,
                "clientInfo": {"name": "windsurf", "version": "1.126.0"},
                "clientCapabilities": {
                    "fs": {"readTextFile": True, "writeTextFile": True},
                    "elicitation": {"form": {}},
                    "_meta": {"terminal_output": True, "cognition.ai/messageGrouping": True},
                },
            })
            session = client.request("session/new", {
                "cwd": str(workspace),
                "mcpServers": [{
                    "name": "shim-smoke",
                    "command": sys.executable,
                    "args": [str(mcp), str(log)],
                    "env": [],
                }],
            })
            session_id = session["sessionId"]
            options = session.get("configOptions", [])
            model_option = next(option for option in options if option.get("category") == "model")
            models = [value for value in model_values(model_option["options"]) if "gemini" in value.lower()]
            if not models:
                raise SmokeError("Antigravity advertised no Gemini model")
            model = min(models, key=lambda value: ("flash" not in value, "low" not in value, value))
            client.request("session/set_config_option", {
                "sessionId": session_id, "configId": model_option["id"], "value": model,
            })
            mode = next((option for option in options if option.get("category") == "mode"), None)
            if mode is not None and "default" in model_values(mode["options"]):
                client.request("session/set_config_option", {
                    "sessionId": session_id, "configId": mode["id"], "value": "default",
                })
            prompt = (
                "This is an isolated ACP integration smoke test. Use real tools, not simulated tool output. "
                f"Read {sample}, then replace its contents with exactly ACP_FILE_OK followed by a newline. "
                f"Run this exact harmless command: {command}. "
                "Call the supplied shim-smoke MCP tool echo_marker with marker ACP_MCP_OK. "
                "Do not read or write outside this temporary workspace, use the network, or start subagents. "
                "Finish by replying with ACP_FILE_OK ACP_COMMAND_OK ACP_MCP_OK."
            )
            result = client.request("session/prompt", {
                "sessionId": session_id, "prompt": [{"type": "text", "text": prompt}],
            }, timeout=150)
            verified = {
                "fileEdited": sample.read_text() == "ACP_FILE_OK\n",
                "commandRan": command_file.exists() and command_file.read_text() == "ACP_COMMAND_OK",
                "mcpCalled": log.exists() and log.read_text() == "ACP_MCP_OK",
                "replyStreamed": all(marker in client.text for marker in (
                    "ACP_FILE_OK", "ACP_COMMAND_OK", "ACP_MCP_OK",
                )),
            }
            ret = {
                "ok": all(verified.values()) and result.get("stopReason") == "end_turn",
                "agentVersion": initialization.get("agentInfo", {}).get("version"),
                "protocolVersion": initialization.get("protocolVersion"),
                "model": model,
                "stopReason": result.get("stopReason"),
                "elapsedMs": round((time.monotonic() - started) * 1000),
                "events": dict(client.events),
                "tools": [{"kind": tool.get("kind"), "status": tool.get("status")} for tool in client.tools.values()],
                "permissionRequests": client.permissions,
                "deniedRequests": client.denied,
                **verified,
            }
        finally:
            client.close()
    return ret


def main() -> int:
    parser = argparse.ArgumentParser(description="Opt-in live Gemini ACP smoke test; consumes provider quota.")
    parser.add_argument("--run-live", action="store_true")
    parser.add_argument("--registry", type=Path)
    arguments = parser.parse_args()
    if not arguments.run_live:
        parser.error("pass --run-live only when a live provider session has been explicitly authorized")
    if arguments.registry:
        registry = json.loads(arguments.registry.read_text())
        entry = next(agent for agent in registry["agents"] if agent["id"] == "devin-better-antigravity")
        architecture = "aarch64" if platform.machine().lower() in ("aarch64", "arm64") else "x86_64"
        launch = entry["distribution"]["binary"][f"linux-{architecture}"]
    else:
        launch = {
            "cmd": sys.executable,
            "args": [
                str(ROOT / "bin/antigravity-acp.py"),
                "--spoof-zed",
                "--",
                "--uid=",
            ],
        }
    try:
        result = run(launch)
    except (SmokeError, OSError, ValueError, StopIteration) as error:
        if isinstance(error, SmokeError):
            print(str(error), file=sys.stderr)
        else:
            print("Live ACP smoke test could not initialize; details redacted.", file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
