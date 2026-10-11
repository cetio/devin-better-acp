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
