#!/usr/bin/env python3

import json
import os
import socket
import sys
from pathlib import Path

if not __package__:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from source.mcp.common import IntegrationError
from source.mcp.tools import TOOLS


NAME = "devin-better-integration"
VERSION = "0.2.0"
PROTOCOL_VERSIONS = {"2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"}
MAX_LOCAL_BYTES = 1024 * 1024
MAX_MESSAGE_BYTES = 16 * 1024 * 1024
SOCKET_TIMEOUT_SECONDS = 600


class IntegrationBridge:
    def __init__(self, socket_path: str, token: str):
        self.socket_path = socket_path
        self.token = token

    def request(self, operation: str, parameters: dict) -> dict:
        request = json.dumps({
            "token": self.token,
            "operation": operation,
            "params": parameters,
        }, ensure_ascii=False, separators=(",", ":")).encode() + b"\n"
        if len(request) > MAX_LOCAL_BYTES:
            raise IntegrationError("The local integration request exceeds the size limit")
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(SOCKET_TIMEOUT_SECONDS)
            connection.connect(self.socket_path)
            connection.sendall(request)
            with connection.makefile("rb") as stream:
                frame = stream.readline(MAX_LOCAL_BYTES + 1)
        if len(frame) > MAX_LOCAL_BYTES or not frame.endswith(b"\n"):
            raise IntegrationError("The local integration bridge returned an invalid response")
        try:
            response = json.loads(frame)
        except (ValueError, UnicodeError, RecursionError):
            raise IntegrationError("The local integration bridge returned an invalid response") from None
        if not isinstance(response, dict):
            raise IntegrationError("The local integration bridge returned an invalid response")
        if "error" in response:
            raise IntegrationError("The client interaction failed")
        ret = response.get("result")
        if not isinstance(ret, dict):
            raise IntegrationError("The local integration bridge returned an invalid result")
        return ret


def tool_list(allow_questions: bool = True) -> list[dict]:
    return [
        {"name": name, "description": tool["description"], "inputSchema": tool["inputSchema"]}
        for name, tool in TOOLS.items()
        if allow_questions or name != "ask_user_question"
    ]


def handle_message(
    message: object,
    bridge: IntegrationBridge | None,
    allow_questions: bool = True,
) -> dict | None:
    if not isinstance(message, dict) or message.get("jsonrpc") != "2.0" or not isinstance(message.get("method"), str):
        return None
    request_id = message.get("id")
    if type(request_id) not in (str, int):
        return None
    method = message["method"]
    parameters = message.get("params", {})
    ret = {"jsonrpc": "2.0", "id": request_id}
    if not isinstance(parameters, dict):
        ret["error"] = {"code": -32602, "message": "Invalid params"}
    elif method == "initialize":
        version = parameters.get("protocolVersion")
        if not isinstance(version, str) or version not in PROTOCOL_VERSIONS:
            ret["error"] = {"code": -32602, "message": "Unsupported MCP protocol version"}
        else:
            ret["result"] = {
                "protocolVersion": version,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": NAME, "version": VERSION},
            }
    elif method == "ping":
        ret["result"] = {}
    elif method == "tools/list":
        ret["result"] = {"tools": tool_list(allow_questions)}
    elif method == "tools/call":
        name = parameters.get("name")
        tool = TOOLS.get(name) if isinstance(name, str) else None
        if name == "ask_user_question" and not allow_questions:
            tool = None
        if tool is None:
            ret["error"] = {"code": -32602, "message": "Unknown integration tool"}
        else:
            try:
                ret["result"] = tool["handler"](parameters.get("arguments", {}), bridge.request if bridge else None)
            except (IntegrationError, OSError, TimeoutError) as error:
                ret["result"] = {"isError": True, "content": [{"type": "text", "text": str(error)}]}
            except Exception:
                ret["result"] = {
                    "isError": True, "content": [{"type": "text", "text": "The integration request failed"}],
                }
    else:
        ret["error"] = {"code": -32601, "message": "Method not found"}
    return ret


def serve() -> int:
    allow_questions = os.environ.get("DBA_FORM_ELICITATION") != "false"
    socket_path = os.environ.get("DBA_INTEGRATION_SOCKET")
    token = os.environ.get("DBA_INTEGRATION_TOKEN")
    bridge = IntegrationBridge(socket_path, token) if allow_questions and socket_path and token else None
    while frame := sys.stdin.buffer.readline(MAX_MESSAGE_BYTES + 1):
        if len(frame) > MAX_MESSAGE_BYTES or not frame.endswith(b"\n"):
            print("Integration MCP: message exceeds the size limit.", file=sys.stderr)
            return 1
        try:
            message = json.loads(frame)
        except (ValueError, UnicodeError, RecursionError):
            print("Integration MCP: invalid JSON-RPC message.", file=sys.stderr)
            continue
        response = handle_message(message, bridge, allow_questions)
        if response is None:
            continue
        output = json.dumps(response, ensure_ascii=False, separators=(",", ":")).encode() + b"\n"
        if len(output) > MAX_MESSAGE_BYTES:
            output = json.dumps({"jsonrpc": "2.0", "id": response["id"], "error": {
                "code": -32603, "message": "Tool output exceeds the size limit",
            }}).encode() + b"\n"
        sys.stdout.buffer.write(output)
        sys.stdout.buffer.flush()
    return 0


def main() -> int:
    if sys.argv[1:] != ["serve"]:
        print("Usage: server.py serve", file=sys.stderr)
        return 2
    return serve()


if __name__ == "__main__":
    raise SystemExit(main())
