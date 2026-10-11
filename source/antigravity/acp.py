#!/usr/bin/env python3

import argparse
import json
import platform
import sys
from pathlib import Path

if not __package__:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from source.antigravity.bridge import Bridge
from source.antigravity.constants import AGENT_TITLE, DEFAULT_DEBUG_LOG, DEFAULT_ICON_URL, DEFAULT_SERVER, VERSION
from source.antigravity.debug import DebugLog


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
    parser.add_argument(
        "--debug",
        action="store_true",
        help="log redacted, bounded ACP traffic and stderr counts to a private file",
    )
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
