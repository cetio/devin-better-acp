import re
import threading


def devin_model_uid(value: object) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    aliases = {
        "gemini-pro-agent": "gemini-3-1-pro-high",
        "claude-sonnet-4-6": "claude-sonnet-4-6-thinking",
    }
    if value in aliases:
        return aliases[value]
    flash = re.fullmatch(r"gemini-3(?:\.0)?-flash-(minimal|low|medium|high)", value)
    if flash is not None:
        return f"MODEL_GOOGLE_GEMINI_3_0_FLASH_{flash.group(1).upper()}"
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


def remap_model_option_values(option: dict) -> tuple[dict[str, str], bool]:
    options = option.get("options")
    if not isinstance(options, list):
        return {}, False
    entries = model_option_entries(options)
    values = {entry["value"] for entry in entries if isinstance(entry.get("value"), str)}
    aliases: dict[str, set[str]] = {}
    for entry in entries:
        value = entry.get("value")
        model_uid = devin_model_uid(value)
        if model_uid is not None and model_uid != value:
            aliases.setdefault(model_uid, set()).add(value)
    ret = {model_uid: next(iter(candidates)) for model_uid, candidates in aliases.items()
           if len(candidates) == 1 and model_uid not in values}
    inverse = {value: model_uid for model_uid, value in ret.items()}
    changed = False
    for entry in entries:
        model_uid = inverse.get(entry.get("value")) if isinstance(entry.get("value"), str) else None
        if model_uid is not None:
            entry["value"] = model_uid
            changed = True
    current = option.get("currentValue")
    if isinstance(current, str) and current in inverse:
        option["currentValue"] = inverse[current]
        changed = True
    return ret, changed


class ModelPicker:
    def __init__(self):
        self.lock = threading.Lock()
        self.values: dict[str, dict[str, dict[str, str]]] = {}

    def update(self, payload: dict, session_id: object) -> bool:
        options = payload.get("configOptions")
        if not isinstance(session_id, str) or not isinstance(options, list):
            return False
        ret = False
        with self.lock:
            session_values = self.values.setdefault(session_id, {})
            for option in options:
                if not isinstance(option, dict) or option.get("category") != "model":
                    continue
                config_id = option.get("id")
                if not isinstance(config_id, str):
                    continue
                values, changed = remap_model_option_values(option)
                session_values[config_id] = values
                ret = changed or ret
        return ret

    def provider_value(self, parameters: dict) -> bool:
        session_id, config_id, value = parameters.get("sessionId"), parameters.get("configId"), parameters.get("value")
        if not all(isinstance(item, str) for item in (session_id, config_id, value)):
            return False
        with self.lock:
            provider = self.values.get(session_id, {}).get(config_id, {}).get(value)
        if provider is None:
            return False
        parameters["value"] = provider
        return provider != value
