from .common import MAX_BATCH_ITEMS, IntegrationError, batch_items, batch_text

import concurrent.futures
import os
import selectors
import shutil
import signal
import subprocess
import time
from typing import Callable


MAX_COMMAND_CHARS = 16000
MAX_STREAM_BYTES = 64 * 1024
MAX_COMMAND_TIMEOUT = 600
SHELL = shutil.which("bash") or shutil.which("sh") or "sh"


def batch_execute_schema() -> dict:
    return {
        "type": "object",
        "properties": {"commands": {
            "type": "array", "minItems": 1, "maxItems": MAX_BATCH_ITEMS,
            "items": {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "minLength": 1, "maxLength": MAX_COMMAND_CHARS},
                    "cwd": {"type": "string", "minLength": 1},
                    "timeout": {"type": "integer", "minimum": 1, "maximum": MAX_COMMAND_TIMEOUT},
                },
                "required": ["command"], "additionalProperties": False,
            },
        }},
        "required": ["commands"], "additionalProperties": False,
    }


def command_specs(arguments: object) -> list[dict]:
    ret: list[dict] = []
    for item in batch_items(arguments, "commands"):
        if not isinstance(item, dict) or set(item) - {"command", "cwd", "timeout"}:
            raise IntegrationError("Each entry needs a command and optional cwd and timeout")
        command = item.get("command")
        cwd = item.get("cwd")
        timeout = item.get("timeout", 120)
        if not isinstance(command, str) or not command.strip() or len(command) > MAX_COMMAND_CHARS:
            raise IntegrationError(f"Each command needs 1 to {MAX_COMMAND_CHARS} characters")
        if cwd is not None and (not isinstance(cwd, str) or not cwd.strip()):
            raise IntegrationError("cwd must be a directory path")
        if type(timeout) is not int or not 1 <= timeout <= MAX_COMMAND_TIMEOUT:
            raise IntegrationError(f"timeout must be between 1 and {MAX_COMMAND_TIMEOUT} seconds")
        ret.append({"command": command, "cwd": cwd, "timeout": timeout})
    return ret


def run_command(spec: dict) -> dict:
    if spec["cwd"] is not None and not os.path.isdir(spec["cwd"]):
        return {"command": spec["command"], "error": "cwd is not a directory"}
    try:
        process = subprocess.Popen(
            [SHELL, "-c", spec["command"]],
            cwd=spec["cwd"],
            env={name: value for name, value in os.environ.items() if not name.startswith("DBA_")},
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
    except OSError as error:
        return {"command": spec["command"], "error": f"Could not start the command (errno {error.errno})"}
    streams = {"stdout": bytearray(), "stderr": bytearray()}
    totals = {"stdout": 0, "stderr": 0}
    deadline = time.monotonic() + spec["timeout"]
    timed_out = False
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ, "stdout")
            selector.register(process.stderr, selectors.EVENT_READ, "stderr")
            while selector.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    timed_out = True
                    break
                for key, _ in selector.select(min(remaining, 0.1)):
                    data = os.read(key.fileobj.fileno(), 8192)
                    if not data:
                        selector.unregister(key.fileobj)
                        continue
                    totals[key.data] += len(data)
                    streams[key.data].extend(data)
                    del streams[key.data][:-MAX_STREAM_BYTES]
            if not timed_out:
                try:
                    process.wait(timeout=max(0.001, deadline - time.monotonic()))
                except subprocess.TimeoutExpired:
                    timed_out = True
    finally:
        if timed_out or process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        process.wait()
        process.stdout.close()
        process.stderr.close()
    ret = {"command": spec["command"], "exit_code": process.returncode}
    for name, data in streams.items():
        ret[name] = data.decode("utf-8", errors="replace")
        if totals[name] > len(data):
            ret[name] = f"[{totals[name] - len(data)} bytes truncated]\n" + ret[name]
    if timed_out:
        ret["timed_out"] = True
    return ret


def batch_execute(arguments: object, request: Callable | None) -> dict:
    specs = command_specs(arguments)
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(specs)) as executor:
        return batch_text(list(executor.map(run_command, specs)))
