from .common import MAX_BATCH_ITEMS, IntegrationError, batch_items, batch_text

import concurrent.futures
import fnmatch
import os
from pathlib import Path


MAX_READ_BYTES = 256 * 1024
MAX_WRITE_BYTES = 1024 * 1024
MAX_SEARCH_FILE_BYTES = 1024 * 1024
MAX_SEARCH_TOTAL_BYTES = 16 * 1024 * 1024
MAX_SEARCH_FILES = 1000
MAX_SEARCH_LINE_CHARS = 256


def batch_read_schema() -> dict:
    return {
        "type": "object",
        "properties": {"files": {
            "type": "array", "minItems": 1, "maxItems": MAX_BATCH_ITEMS,
            "items": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "minLength": 1},
                    "offset": {"type": "integer", "minimum": 1},
                    "limit": {"type": "integer", "minimum": 1},
                },
                "required": ["path"], "additionalProperties": False,
            },
        }},
        "required": ["files"], "additionalProperties": False,
    }


def batch_write_schema() -> dict:
    return {
        "type": "object",
        "properties": {"files": {
            "type": "array", "minItems": 1, "maxItems": MAX_BATCH_ITEMS,
            "items": {
                "type": "object",
                "properties": {"path": {"type": "string", "minLength": 1}, "content": {"type": "string"}},
                "required": ["path", "content"], "additionalProperties": False,
            },
        }},
        "required": ["files"], "additionalProperties": False,
    }


def batch_edit_schema() -> dict:
    return {
        "type": "object",
        "properties": {"files": {
            "type": "array", "minItems": 1, "maxItems": MAX_BATCH_ITEMS,
            "items": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "minLength": 1},
                    "edits": {
                        "type": "array", "minItems": 1, "maxItems": 16,
                        "items": {
                            "type": "object",
                            "properties": {
                                "oldText": {"type": "string", "minLength": 1},
                                "newText": {"type": "string"},
                            },
                            "required": ["oldText", "newText"], "additionalProperties": False,
                        },
                    },
                },
                "required": ["path", "edits"], "additionalProperties": False,
            },
        }},
        "required": ["files"], "additionalProperties": False,
    }


def batch_search_schema() -> dict:
    return {
        "type": "object",
        "properties": {"searches": {
            "type": "array", "minItems": 1, "maxItems": MAX_BATCH_ITEMS,
            "items": {
                "type": "object",
                "properties": {
                    "pattern": {"type": "string", "minLength": 1, "maxLength": 2048},
                    "path": {"type": "string", "minLength": 1},
                    "glob_pattern": {"type": "string", "minLength": 1},
                    "case_insensitive": {"type": "boolean"},
                    "output_mode": {"type": "string", "enum": ["content", "files_with_matches", "count"]},
                    "max_results": {"type": "integer", "minimum": 1, "maximum": 50},
                    "context_lines": {"type": "integer", "minimum": 0, "maximum": 2},
                },
                "required": ["pattern"], "additionalProperties": False,
            },
        }},
        "required": ["searches"], "additionalProperties": False,
    }


def read_specs(arguments: object) -> list[dict]:
    ret: list[dict] = []
    for item in batch_items(arguments, "files"):
        if not isinstance(item, dict) or set(item) - {"path", "offset", "limit"}:
            raise IntegrationError("Each entry needs a path and optional offset and limit")
        path = item.get("path")
        offset = item.get("offset", 1)
        limit = item.get("limit")
        if not isinstance(path, str) or not path:
            raise IntegrationError("Each file needs a path")
        if type(offset) is not int or offset < 1:
            raise IntegrationError("offset must be a positive line number")
        if limit is not None and (type(limit) is not int or limit < 1):
            raise IntegrationError("limit must be a positive line count")
        ret.append({"path": path, "offset": offset, "limit": limit})
    return ret


def write_specs(arguments: object) -> list[dict]:
    ret: list[dict] = []
    for item in batch_items(arguments, "files"):
        if not isinstance(item, dict) or set(item) != {"path", "content"}:
            raise IntegrationError("Each entry needs a path and content")
        path = item["path"]
        content = item["content"]
        if not isinstance(path, str) or not path:
            raise IntegrationError("Each file needs a path")
        if not isinstance(content, str) or len(content.encode("utf-8")) > MAX_WRITE_BYTES:
            raise IntegrationError(f"Each file needs text content within {MAX_WRITE_BYTES // 1024} KiB")
        ret.append({"path": path, "content": content})
    return ret


def edit_specs(arguments: object) -> list[dict]:
    ret = batch_items(arguments, "files")
    paths = set()
    for item in ret:
        if not isinstance(item, dict) or set(item) != {"path", "edits"}:
            raise IntegrationError("Each file needs a path and edits")
        path, edits = item["path"], item["edits"]
        if not isinstance(path, str) or not path:
            raise IntegrationError("Each file needs a path")
        if path in paths:
            raise IntegrationError("Each file path must be unique within a batch")
        paths.add(path)
        if not isinstance(edits, list) or not 1 <= len(edits) <= 16:
            raise IntegrationError("Each file needs one to sixteen exact-text edits")
        for edit in edits:
            if not isinstance(edit, dict) or set(edit) != {"oldText", "newText"}:
                raise IntegrationError("Each edit needs oldText and newText")
            if not isinstance(edit["oldText"], str) or not edit["oldText"]:
                raise IntegrationError("oldText must be a non-empty string")
            if not isinstance(edit["newText"], str):
                raise IntegrationError("newText must be a string")
    return ret


def search_specs(arguments: object) -> list[dict]:
    ret: list[dict] = []
    for item in batch_items(arguments, "searches"):
        fields = {"pattern", "path", "glob_pattern", "case_insensitive", "output_mode", "max_results",
                  "context_lines"}
        if not isinstance(item, dict) or set(item) - fields:
            raise IntegrationError("Each search contains an unsupported field")
        pattern = item.get("pattern")
        path = item.get("path", ".")
        glob_pattern = item.get("glob_pattern")
        insensitive = item.get("case_insensitive", False)
        output_mode = item.get("output_mode", "content")
        max_results = item.get("max_results", 50)
        context_lines = item.get("context_lines", 0)
        if not isinstance(pattern, str) or not pattern or len(pattern) > 2048:
            raise IntegrationError("Each search needs a pattern of at most 2048 characters")
        if not isinstance(path, str) or not path:
            raise IntegrationError("Search path must be a file or directory")
        if glob_pattern is not None and (not isinstance(glob_pattern, str) or not glob_pattern):
            raise IntegrationError("glob_pattern must be a non-empty string")
        if type(insensitive) is not bool:
            raise IntegrationError("case_insensitive must be a boolean")
        if output_mode not in ("content", "files_with_matches", "count"):
            raise IntegrationError("output_mode must be content, files_with_matches, or count")
        if type(max_results) is not int or not 1 <= max_results <= 50:
            raise IntegrationError("max_results must be between 1 and 50")
        if type(context_lines) is not int or not 0 <= context_lines <= 2:
            raise IntegrationError("context_lines must be between 0 and 2")
        ret.append({
            "pattern": pattern,
            "search_pattern": pattern.casefold() if insensitive else pattern,
            "case_insensitive": insensitive,
            "path": path,
            "glob_pattern": glob_pattern,
            "output_mode": output_mode,
            "max_results": max_results,
            "context_lines": context_lines,
        })
    return ret


def read_file(spec: dict) -> dict:
    try:
        with open(spec["path"], "rb") as stream:
            data = stream.read(MAX_READ_BYTES + 1)
    except OSError as error:
        return {"path": spec["path"], "error": str(error)}
    if b"\x00" in data[:8192]:
        return {"path": spec["path"], "error": "The file is binary"}
    lines = data[:MAX_READ_BYTES].decode("utf-8", errors="replace").splitlines()
    ret = {"path": spec["path"], "line_count": len(lines)}
    lines = lines[spec["offset"] - 1:]
    if spec["limit"] is not None:
        lines = lines[:spec["limit"]]
    ret["content"] = "\n".join(lines)
    if len(data) > MAX_READ_BYTES:
        ret["truncated"] = True
    return ret


def write_file(spec: dict) -> dict:
    try:
        target = Path(spec["path"])
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(spec["content"], encoding="utf-8")
    except OSError as error:
        return {"path": spec["path"], "error": str(error)}
    return {"path": spec["path"], "bytes": len(spec["content"].encode("utf-8"))}


def edit_file(spec: dict) -> dict:
    path = spec["path"]
    try:
        with open(path, "rb") as stream:
            original = stream.read(MAX_WRITE_BYTES + 1)
    except OSError as error:
        return {"path": path, "error": str(error)}
    if len(original) > MAX_WRITE_BYTES or b"\x00" in original[:8192]:
        return {"path": path, "error": "The file is binary or exceeds the edit size limit"}
    try:
        original.decode("utf-8")
        edited = original
        for index, operation in enumerate(spec["edits"], 1):
            old_text = operation["oldText"].encode("utf-8")
            count = edited.count(old_text)
            if count != 1:
                return {"path": path, "error": f"Edit {index} matched {count} times; expected exactly once"}
            edited = edited.replace(old_text, operation["newText"].encode("utf-8"), 1)
    except UnicodeError:
        return {"path": path, "error": "The file is not valid UTF-8"}
    if len(edited) > MAX_WRITE_BYTES:
        return {"path": path, "error": "The edited file exceeds the size limit"}
    try:
        Path(path).write_bytes(edited)
    except OSError as error:
        return {"path": path, "error": str(error)}
    return {"path": path, "edits": len(spec["edits"]), "bytes": len(edited)}


def search_file(path: Path, root: Path, spec: dict) -> tuple[dict | None, int]:
    try:
        with path.open("rb") as stream:
            data = stream.read(MAX_SEARCH_FILE_BYTES + 1)
    except OSError:
        return None, 0
    if len(data) > MAX_SEARCH_FILE_BYTES or b"\x00" in data[:8192]:
        return None, min(len(data), MAX_SEARCH_FILE_BYTES + 1)
    lines = data.decode("utf-8", errors="replace").splitlines()
    matches: list[dict] = []
    for index, line in enumerate(lines):
        search_line = line.casefold() if spec["case_insensitive"] else line
        column = search_line.find(spec["search_pattern"])
        if column < 0:
            continue
        relative_path = str(path.relative_to(root)) if path != root else path.name
        result = {"path": relative_path, "line_number": index + 1,
                  "column": column + 1, "line": line[:MAX_SEARCH_LINE_CHARS]}
        if spec["context_lines"]:
            start = max(0, index - spec["context_lines"])
            end = min(len(lines), index + spec["context_lines"] + 1)
            result["context"] = [line[:MAX_SEARCH_LINE_CHARS] for line in lines[start:end]]
        matches.append(result)
        if len(matches) >= spec["max_results"]:
            break
    if not matches:
        return None, len(data)
    return {"path": relative_path, "matches": matches}, len(data)


def search_query(spec: dict) -> dict:
    root = Path(spec["path"]).expanduser()
    if not root.exists():
        return {"path": spec["path"], "error": "Search path does not exist"}
    root = root.resolve()
    if root.is_file():
        walk = [(str(root.parent), [], [root.name])]
    elif root.is_dir():
        walk = os.walk(root)
    else:
        return {"path": spec["path"], "error": "Search path is not a file or directory"}
    ret = {"path": spec["path"], "pattern": spec["pattern"], "output_mode": spec["output_mode"]}
    matches: list[dict] = []
    matched_paths: list[str] = []
    total_matches = 0
    bytes_scanned = 0
    files_scanned = 0
    truncated = False
    for directory, directories, names in walk:
        directories[:] = sorted(name for name in directories
                                if name not in (".git", "node_modules", "__pycache__"))
        for name in sorted(names):
            path = Path(directory) / name
            relative = path.relative_to(root) if root.is_dir() else Path(name)
            if spec["glob_pattern"] and not fnmatch.fnmatch(str(relative), spec["glob_pattern"]):
                continue
            if files_scanned >= MAX_SEARCH_FILES or bytes_scanned >= MAX_SEARCH_TOTAL_BYTES:
                truncated = True
                break
            result, consumed = search_file(path, root, spec)
            files_scanned += 1
            bytes_scanned += consumed
            if bytes_scanned > MAX_SEARCH_TOTAL_BYTES or consumed > MAX_SEARCH_FILE_BYTES:
                truncated = True
            if result is not None:
                matched_paths.append(result["path"])
                total_matches += len(result["matches"])
                matches.extend(result["matches"])
                if len(matches) >= spec["max_results"]:
                    matches = matches[:spec["max_results"]]
                    truncated = True
                    break
        if truncated:
            break
    if spec["output_mode"] == "files_with_matches":
        ret["files"] = matched_paths[:spec["max_results"]]
    elif spec["output_mode"] == "count":
        ret["count"] = total_matches
    else:
        ret["matches"] = matches
    ret["files_scanned"] = files_scanned
    if truncated:
        ret["truncated"] = True
    return ret


def batch_read(arguments: object, request: object = None) -> dict:
    return batch_text([read_file(spec) for spec in read_specs(arguments)])


def batch_write(arguments: object, request: object = None) -> dict:
    return batch_text([write_file(spec) for spec in write_specs(arguments)])


def batch_edit(arguments: object, request: object = None) -> dict:
    specs = edit_specs(arguments)
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(specs)) as executor:
        return batch_text(list(executor.map(edit_file, specs)))


def batch_search(arguments: object, request: object = None) -> dict:
    specs = search_specs(arguments)
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(specs)) as executor:
        return batch_text(list(executor.map(search_query, specs)))
