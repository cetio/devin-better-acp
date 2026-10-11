import re


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
