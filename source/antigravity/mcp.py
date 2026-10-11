import json
import sys
from pathlib import Path


INTEGRATION_NAME = "devin-better-integration"


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


def is_integration_server(server: object, script: Path) -> bool:
    if not isinstance(server, dict) or server.get("name") != INTEGRATION_NAME:
        return False
    arguments = server.get("args")
    environment = server.get("env")
    return (
        isinstance(arguments, list)
        and str(script) in arguments
        and "serve" in arguments
        and isinstance(environment, list)
        and any(
            isinstance(item, dict) and item.get("name") == "DBA_INTEGRATION_TOKEN"
            for item in environment
        )
    )


def integration_mcp_server(socket_path: Path, token: str, script: Path) -> dict:
    return {
        "name": INTEGRATION_NAME,
        "command": str(Path(sys.executable).absolute()),
        "args": [str(script), "serve"],
        "env": [
            {"name": "DBA_INTEGRATION_SOCKET", "value": str(socket_path)},
            {"name": "DBA_INTEGRATION_TOKEN", "value": token},
        ],
    }


def install_integration_server(parameters: dict, socket_path: Path, token: str, script: Path) -> bool:
    current = parameters.get("mcpServers")
    servers = list(current) if isinstance(current, list) else []
    matches = [
        index for index, server in enumerate(servers)
        if isinstance(server, dict) and server.get("name") == INTEGRATION_NAME
    ]
    if matches and any(not is_integration_server(servers[index], script) for index in matches):
        return False
    entry = integration_mcp_server(socket_path, token, script)
    if matches:
        servers[matches[0]] = entry
        servers = [
            server for index, server in enumerate(servers)
            if index == matches[0] or not isinstance(server, dict) or server.get("name") != INTEGRATION_NAME
        ]
    else:
        servers.append(entry)
    parameters["mcpServers"] = servers
    return True
