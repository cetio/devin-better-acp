import json


class IntegrationError(ValueError):
    pass


MAX_BATCH_ITEMS = 8


def batch_text(results: list[dict]) -> dict:
    return {"content": [{"type": "text", "text": json.dumps({"results": results}, ensure_ascii=False)}]}


def batch_items(arguments: object, field: str) -> list:
    if not isinstance(arguments, dict) or set(arguments) != {field}:
        raise IntegrationError(f"Provide one to {MAX_BATCH_ITEMS} {field}")
    ret = arguments[field]
    if not isinstance(ret, list) or not 1 <= len(ret) <= MAX_BATCH_ITEMS:
        raise IntegrationError(f"Provide one to {MAX_BATCH_ITEMS} {field}")
    return ret
