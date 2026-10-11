#!/usr/bin/env python3

# TODO: Investigate passing custom system instructions through the ACP server for Devin-style Antigravity behavior.

import concurrent.futures
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
from pathlib import Path


NAME = "devin-better-integration"
VERSION = "0.1.0"
PROTOCOL_VERSIONS = {"2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"}
MAX_MESSAGE_BYTES = 1024 * 1024
SOCKET_TIMEOUT_SECONDS = 600
SHELL = shutil.which("bash") or shutil.which("sh") or "sh"
MAX_BATCH_ITEMS = 8
MAX_COMMAND_CHARS = 16000
MAX_STREAM_BYTES = 64 * 1024
MAX_READ_BYTES = 256 * 1024
MAX_WRITE_BYTES = 1024 * 1024
DEFAULT_COMMAND_TIMEOUT = 120
MAX_COMMAND_TIMEOUT = 600


class IntegrationError(ValueError):
    pass


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
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(SOCKET_TIMEOUT_SECONDS)
            connection.connect(self.socket_path)
            connection.sendall(request)
            with connection.makefile("rb") as response_stream:
                response_frame = response_stream.readline(MAX_MESSAGE_BYTES + 1)
        if len(response_frame) > MAX_MESSAGE_BYTES or not response_frame.endswith(b"\n"):
            raise IntegrationError("The local integration bridge returned an invalid response")
        try:
            response = json.loads(response_frame)
        except (ValueError, UnicodeError, RecursionError):
            raise IntegrationError("The local integration bridge returned an invalid response") from None
        if not isinstance(response, dict):
            raise IntegrationError("The local integration bridge returned an invalid response")
        if "error" in response:
            message = response["error"] if isinstance(response["error"], str) else "The interaction failed"
            raise IntegrationError(message)
        result = response.get("result")
        if not isinstance(result, dict):
            raise IntegrationError("The local integration bridge returned an invalid result")
        return result


def question_tool_schema() -> dict:
    return {
        "type": "object",
        "properties": {
            "questions": {
                "type": "array",
                "minItems": 1,
                "maxItems": 4,
                "items": {
                    "type": "object",
                    "properties": {
                        "question": {"type": "string", "minLength": 1},
                        "header": {"type": "string", "minLength": 1, "maxLength": 16},
                        "options": {
                            "type": "array",
                            "minItems": 2,
                            "maxItems": 4,
                            "items": {
                                "type": "object",
                                "properties": {
                                    "label": {"type": "string", "minLength": 1},
                                    "description": {"type": "string"},
                                },
                                "required": ["label"],
                                "additionalProperties": False,
                            },
                        },
                        "multi_select": {"type": "boolean"},
                    },
                    "required": ["question", "header", "options"],
                    "additionalProperties": False,
                },
            },
        },
        "required": ["questions"],
        "additionalProperties": False,
    }


def build_question_form(arguments: object) -> tuple[dict, list[dict]]:
    if not isinstance(arguments, dict) or set(arguments) != {"questions"}:
        raise IntegrationError("Provide one to four questions")
    questions = arguments.get("questions")
    if not isinstance(questions, list) or not 1 <= len(questions) <= 4:
        raise IntegrationError("Provide one to four questions")
    properties: dict[str, dict] = {}
    required: list[str] = []
    messages: list[str] = []
    normalized_questions: list[dict] = []
    for index, question in enumerate(questions, 1):
        if not isinstance(question, dict):
            raise IntegrationError("Each question must be an object")
        if set(question) - {"question", "header", "options", "multi_select"}:
            raise IntegrationError("A question contains an unsupported field")
        prompt = question.get("question")
        header = question.get("header")
        options = question.get("options")
        multi_select = question.get("multi_select", False)
        if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 5000:
            raise IntegrationError("Each question needs 1 to 5000 characters of question text")
        if not isinstance(header, str) or not header.strip() or len(header) > 16:
            raise IntegrationError("Each question header must contain 1 to 16 characters")
        if not isinstance(options, list) or not 2 <= len(options) <= 4:
            raise IntegrationError("Each question needs two to four options")
        if not isinstance(multi_select, bool):
            raise IntegrationError("multi_select must be a boolean")
        normalized_options: list[dict] = []
        labels: set[str] = set()
        for option in options:
            if not isinstance(option, dict) or set(option) - {"label", "description"}:
                raise IntegrationError("Each option must contain a label and optional description")
            label = option.get("label")
            description = option.get("description", "")
            if not isinstance(label, str) or not label.strip() or len(label) > 200:
                raise IntegrationError("Each option label must contain 1 to 200 characters")
            if not isinstance(description, str) or len(description) > 1000:
                raise IntegrationError("Each option description must contain at most 1000 characters")
            if label in labels:
                raise IntegrationError("Option labels must be unique within a question")
            labels.add(label)
            normalized_options.append({"label": label, "description": description})
        field_name = f"question_{index}"
        other_name = f"question_{index}_other"
        if multi_select:
            option_fields: list[str] = []
            for option_index, option in enumerate(normalized_options, 1):
                option_field = f"{field_name}_option_{option_index}"
                properties[option_field] = {
                    "type": "boolean",
                    "title": option["label"],
                    "description": option["description"] or prompt,
                }
                option_fields.append(option_field)
            properties[other_name] = {
                "type": "boolean",
                "title": "Other",
                "description": "Select to provide a different answer.",
            }
            properties[f"{other_name}_text"] = {
                "type": "string",
                "title": f"{header} (Other)",
                "description": prompt,
            }
            normalized_questions.append({
                "question": prompt,
                "header": header,
                "multi_select": True,
                "option_fields": option_fields,
                "options": normalized_options,
                "other_field": other_name,
                "other_text_field": f"{other_name}_text",
            })
        else:
            labels_with_other = [option["label"] for option in normalized_options]
            if "Other" not in labels_with_other:
                labels_with_other.append("Other")
            properties[field_name] = {
                "type": "string",
                "title": header,
                "description": prompt,
                "enum": labels_with_other,
            }
            properties[other_name] = {
                "type": "string",
                "title": f"{header} (Other)",
                "description": "Enter a different answer, or leave blank.",
            }
            required.append(field_name)
            normalized_questions.append({
                "question": prompt,
                "header": header,
                "multi_select": False,
                "field": field_name,
                "other_field": other_name,
                "options": normalized_options,
            })
        message = f"{index}. {header}: {prompt}"
        for option in normalized_options:
            message += f"\n   - {option['label']}"
            if option["description"]:
                message += f": {option['description']}"
        messages.append(message)
    return {
        "mode": "form",
        "message": "The agent needs your input. Review the questions and submit your answers.\n\n"
        + "\n\n".join(messages),
        "requestedSchema": {"type": "object", "properties": properties, "required": required},
    }, normalized_questions


def render_question_answers(content: object, questions: list[dict]) -> dict:
    if not isinstance(content, dict):
        raise IntegrationError("The client accepted the form without returning answers")
    answers: list[dict] = []
    for question in questions:
        if question["multi_select"]:
            field_names = [*question["option_fields"], question["other_field"]]
            if any(field_name in content and not isinstance(content[field_name], bool) for field_name in field_names):
                raise IntegrationError("The client returned an invalid multi-select answer")
            selected = [
                option["label"] for option, field_name in zip(question["options"], question["option_fields"])
                if content.get(field_name) is True
            ]
            if content.get(question["other_field"]) is True:
                other_text = content.get(question["other_text_field"])
                if isinstance(other_text, str) and other_text.strip():
                    selected.append(other_text.strip())
                elif other_text is None:
                    selected.append("Other")
                else:
                    raise IntegrationError("The client returned an invalid custom answer")
            answer: object = selected
        else:
            selected = content.get(question["field"])
            valid_options = {option["label"] for option in question["options"]} | {"Other"}
            if not isinstance(selected, str) or selected not in valid_options:
                raise IntegrationError("The client accepted the form without a valid answer")
            if question["other_field"] in content and not isinstance(content[question["other_field"]], str):
                raise IntegrationError("The client returned an invalid custom answer")
            if selected == "Other":
                other_text = content.get(question["other_field"])
                if isinstance(other_text, str) and other_text.strip():
                    selected = other_text.strip()
            answer = selected
        answers.append({"question": question["question"], "answer": answer})
    return {"answers": answers}


def ask_user_question(arguments: object, bridge: IntegrationBridge | None) -> dict:
    if bridge is None:
        raise IntegrationError("The local integration bridge is unavailable")
    parameters, questions = build_question_form(arguments)
    response = bridge.request("elicitation/create", parameters)
    action = response.get("action")
    if action != "accept":
        reason = "declined" if action == "decline" else "cancelled"
        return {
            "isError": True,
            "content": [{"type": "text", "text": f"The user {reason} the question."}],
        }
    answers = render_question_answers(response.get("content"), questions)
    return {"content": [{"type": "text", "text": json.dumps(answers, ensure_ascii=False)}]}


def batch_execute_schema() -> dict:
    return {
        "type": "object",
        "properties": {
            "commands": {
                "type": "array",
                "minItems": 1,
                "maxItems": MAX_BATCH_ITEMS,
                "items": {
                    "type": "object",
                    "properties": {
                        "command": {"type": "string", "minLength": 1},
                        "cwd": {"type": "string", "minLength": 1},
                        "timeout": {"type": "integer", "minimum": 1, "maximum": MAX_COMMAND_TIMEOUT},
                    },
                    "required": ["command"],
                    "additionalProperties": False,
                },
            },
        },
        "required": ["commands"],
        "additionalProperties": False,
    }


def batch_read_schema() -> dict:
    return {
        "type": "object",
        "properties": {
            "files": {
                "type": "array",
                "minItems": 1,
                "maxItems": MAX_BATCH_ITEMS,
                "items": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "minLength": 1},
                        "offset": {"type": "integer", "minimum": 1},
                        "limit": {"type": "integer", "minimum": 1},
                    },
                    "required": ["path"],
                    "additionalProperties": False,
                },
            },
        },
        "required": ["files"],
        "additionalProperties": False,
    }


def batch_write_schema() -> dict:
    return {
        "type": "object",
        "properties": {
            "files": {
                "type": "array",
                "minItems": 1,
                "maxItems": MAX_BATCH_ITEMS,
                "items": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "minLength": 1},
                        "content": {"type": "string"},
                    },
                    "required": ["path", "content"],
                    "additionalProperties": False,
                },
            },
        },
        "required": ["files"],
        "additionalProperties": False,
    }


def command_specs(arguments: object) -> list[dict]:
    if not isinstance(arguments, dict) or set(arguments) != {"commands"}:
        raise IntegrationError(f"Provide one to {MAX_BATCH_ITEMS} commands")
    commands = arguments["commands"]
    if not isinstance(commands, list) or not 1 <= len(commands) <= MAX_BATCH_ITEMS:
        raise IntegrationError(f"Provide one to {MAX_BATCH_ITEMS} commands")
    ret: list[dict] = []
    for item in commands:
        if not isinstance(item, dict) or set(item) - {"command", "cwd", "timeout"}:
            raise IntegrationError("Each entry needs a command and optional cwd and timeout")
        command = item.get("command")
        if not isinstance(command, str) or not command.strip() or len(command) > MAX_COMMAND_CHARS:
            raise IntegrationError(f"Each command needs 1 to {MAX_COMMAND_CHARS} characters")
        cwd = item.get("cwd")
        if cwd is not None and (not isinstance(cwd, str) or not cwd.strip()):
            raise IntegrationError("cwd must be a directory path")
        timeout = item.get("timeout", DEFAULT_COMMAND_TIMEOUT)
        if not isinstance(timeout, int) or isinstance(timeout, bool) or not 1 <= timeout <= MAX_COMMAND_TIMEOUT:
            raise IntegrationError(f"timeout must be between 1 and {MAX_COMMAND_TIMEOUT} seconds")
        ret.append({"command": command, "cwd": cwd, "timeout": timeout})
    return ret


def files_argument(arguments: object) -> list:
    if not isinstance(arguments, dict) or set(arguments) != {"files"}:
        raise IntegrationError(f"Provide one to {MAX_BATCH_ITEMS} files")
    files = arguments["files"]
    if not isinstance(files, list) or not 1 <= len(files) <= MAX_BATCH_ITEMS:
        raise IntegrationError(f"Provide one to {MAX_BATCH_ITEMS} files")
    return files


def read_specs(arguments: object) -> list[dict]:
    ret: list[dict] = []
    for item in files_argument(arguments):
        if not isinstance(item, dict) or set(item) - {"path", "offset", "limit"}:
            raise IntegrationError("Each entry needs a path and optional offset and limit")
        path = item.get("path")
        if not isinstance(path, str) or not path:
            raise IntegrationError("Each file needs a path")
        offset = item.get("offset", 1)
        limit = item.get("limit")
        if not isinstance(offset, int) or isinstance(offset, bool) or offset < 1:
            raise IntegrationError("offset must be a positive line number")
        if limit is not None and (not isinstance(limit, int) or isinstance(limit, bool) or limit < 1):
            raise IntegrationError("limit must be a positive line count")
        ret.append({"path": path, "offset": offset, "limit": limit})
    return ret


def write_specs(arguments: object) -> list[dict]:
    ret: list[dict] = []
    for item in files_argument(arguments):
        if not isinstance(item, dict) or set(item) != {"path", "content"}:
            raise IntegrationError("Each entry needs a path and content")
        path = item.get("path")
        content = item.get("content")
        if not isinstance(path, str) or not path:
            raise IntegrationError("Each file needs a path")
        if not isinstance(content, str) or len(content.encode("utf-8")) > MAX_WRITE_BYTES:
            raise IntegrationError(f"Each file needs text content within {MAX_WRITE_BYTES // 1024} KiB")
        ret.append({"path": path, "content": content})
    return ret


def stream_text(data: bytes) -> str:
    if len(data) <= MAX_STREAM_BYTES:
        return data.decode("utf-8", errors="replace")
    truncated = data[-MAX_STREAM_BYTES:].decode("utf-8", errors="replace")
    return f"[{len(data) - MAX_STREAM_BYTES} bytes truncated]\n{truncated}"


def run_command(spec: dict) -> dict:
    cwd = spec["cwd"]
    if cwd is not None and not os.path.isdir(cwd):
        return {"command": spec["command"], "error": "cwd is not a directory"}
    environment = {name: value for name, value in os.environ.items() if not name.startswith("DBA_")}
    try:
        process = subprocess.Popen(
            [SHELL, "-c", spec["command"]],
            cwd=cwd,
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
    except OSError as error:
        return {"command": spec["command"], "error": f"Could not start the command: {error}"}
    timed_out = False
    try:
        stdout, stderr = process.communicate(timeout=spec["timeout"])
    except subprocess.TimeoutExpired:
        timed_out = True
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        stdout, stderr = process.communicate()
    ret = {
        "command": spec["command"],
        "exit_code": process.returncode,
        "stdout": stream_text(stdout),
        "stderr": stream_text(stderr),
    }
    if timed_out:
        ret["timed_out"] = True
    return ret


def read_file(spec: dict) -> dict:
    path = spec["path"]
    try:
        with open(path, "rb") as stream:
            data = stream.read(MAX_READ_BYTES + 1)
    except OSError as error:
        return {"path": path, "error": str(error)}
    if b"\x00" in data[:8192]:
        return {"path": path, "error": "The file is binary"}
    truncated = len(data) > MAX_READ_BYTES
    lines = data[:MAX_READ_BYTES].decode("utf-8", errors="replace").splitlines()
    ret = {"path": path, "line_count": len(lines)}
    lines = lines[spec["offset"] - 1:]
    if spec["limit"] is not None:
        lines = lines[:spec["limit"]]
    ret["content"] = "\n".join(lines)
    if truncated:
        ret["truncated"] = True
    return ret


def write_file(spec: dict) -> dict:
    path = spec["path"]
    data = spec["content"].encode("utf-8")
    try:
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    except OSError as error:
        return {"path": path, "error": str(error)}
    return {"path": path, "bytes": len(data)}


def batch_text(results: list[dict]) -> dict:
    return {"content": [{"type": "text", "text": json.dumps({"results": results}, ensure_ascii=False)}]}


def batch_execute(arguments: object, bridge: IntegrationBridge | None) -> dict:
    specs = command_specs(arguments)
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(specs)) as executor:
        results = list(executor.map(run_command, specs))
    return batch_text(results)


def batch_read(arguments: object, bridge: IntegrationBridge | None) -> dict:
    return batch_text([read_file(spec) for spec in read_specs(arguments)])


def batch_write(arguments: object, bridge: IntegrationBridge | None) -> dict:
    return batch_text([write_file(spec) for spec in write_specs(arguments)])


INTEGRATIONS = {
    "ask_user_question": {
        "description": "Ask the user one to four structured questions and wait for their answers.",
        "inputSchema": question_tool_schema(),
        "handler": ask_user_question,
    },
    "batch_execute": {
        "description": "Run up to 8 shell commands in parallel via bash. Each command may set a cwd and "
        "a timeout in seconds (default 120, maximum 600) and is killed with its process group on timeout. "
        "Output is truncated to the last 64 KiB per stream. Returns per-command exit_code, stdout, stderr, "
        "and timed_out, or a per-command error.",
        "inputSchema": batch_execute_schema(),
        "handler": batch_execute,
    },
    "batch_read": {
        "description": "Read up to 8 text files in one call. Each entry may set a 1-based line offset and a "
        "line limit. Contents are capped at 256 KiB per file. Returns per-file content, line_count, and "
        "truncated, or a per-file error.",
        "inputSchema": batch_read_schema(),
        "handler": batch_read,
    },
    "batch_write": {
        "description": "Write up to 8 files in one call, creating parent directories and overwriting existing "
        "files. Returns per-file byte counts or per-file errors.",
        "inputSchema": batch_write_schema(),
        "handler": batch_write,
    },
}


def tool_list() -> list[dict]:
    return [
        {"name": name, "description": integration["description"], "inputSchema": integration["inputSchema"]}
        for name, integration in INTEGRATIONS.items()
    ]


def handle_message(message: object, bridge: IntegrationBridge | None) -> dict | None:
    if not isinstance(message, dict) or message.get("jsonrpc") != "2.0" or not isinstance(message.get("method"), str):
        return None
    request_id = message.get("id")
    method = message["method"]
    parameters = message.get("params")
    parameters = parameters if isinstance(parameters, dict) else {}
    if request_id is None:
        return None
    if method == "initialize":
        requested_version = parameters.get("protocolVersion")
        if requested_version not in PROTOCOL_VERSIONS:
            return {"jsonrpc": "2.0", "id": request_id, "error": {
                "code": -32602,
                "message": "Unsupported MCP protocol version",
            }}
        return {"jsonrpc": "2.0", "id": request_id, "result": {
            "protocolVersion": requested_version,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": NAME, "version": VERSION},
        }}
    if method == "ping":
        return {"jsonrpc": "2.0", "id": request_id, "result": {}}
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": request_id, "result": {"tools": tool_list()}}
    if method != "tools/call":
        return {"jsonrpc": "2.0", "id": request_id, "error": {
            "code": -32601,
            "message": "Method not found",
        }}
    name = parameters.get("name")
    integration = INTEGRATIONS.get(name) if isinstance(name, str) else None
    if integration is None:
        return {"jsonrpc": "2.0", "id": request_id, "error": {
            "code": -32602,
            "message": "Unknown integration tool",
        }}
    try:
        result = integration["handler"](parameters.get("arguments", {}), bridge)
    except (IntegrationError, OSError, TimeoutError) as error:
        result = {"isError": True, "content": [{"type": "text", "text": str(error)}]}
    except Exception:
        result = {"isError": True, "content": [{"type": "text", "text": "The integration request failed."}]}
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def serve() -> int:
    socket_path = os.environ.get("DBA_INTEGRATION_SOCKET")
    token = os.environ.get("DBA_INTEGRATION_TOKEN")
    bridge = IntegrationBridge(socket_path, token) if socket_path and token else None
    while frame := sys.stdin.buffer.readline(MAX_MESSAGE_BYTES + 1):
        if len(frame) > MAX_MESSAGE_BYTES or not frame.endswith(b"\n"):
            print("Integration MCP: message exceeds the size limit.", file=sys.stderr)
            return 1
        try:
            message = json.loads(frame)
        except (ValueError, UnicodeError, RecursionError):
            print("Integration MCP: invalid JSON-RPC message.", file=sys.stderr)
            continue
        response = handle_message(message, bridge)
        if response is not None:
            sys.stdout.buffer.write(json.dumps(response, ensure_ascii=False, separators=(",", ":")).encode() + b"\n")
            sys.stdout.buffer.flush()
    return 0


def main() -> int:
    if sys.argv[1:] != ["serve"]:
        print("Usage: devin-better-integration.py serve", file=sys.stderr)
        return 2
    return serve()


if __name__ == "__main__":
    raise SystemExit(main())
