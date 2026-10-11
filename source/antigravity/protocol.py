import json
from typing import BinaryIO


MAX_FRAME_BYTES = 16 * 1024 * 1024


class ProtocolError(ValueError):
    pass


def read_frame(stream: BinaryIO, limit: int = MAX_FRAME_BYTES) -> bytes | None:
    while True:
        ret = stream.readline(limit + 1)
        if len(ret) > limit:
            raise ProtocolError("JSON-RPC frame exceeded the size limit")
        if not ret or ret.strip():
            return ret or None


def decode_frame(frame: bytes) -> dict:
    try:
        ret = json.loads(frame)
    except (ValueError, UnicodeError, RecursionError):
        raise ProtocolError("invalid JSON-RPC frame") from None
    if not isinstance(ret, dict) or ret.get("jsonrpc") != "2.0":
        raise ProtocolError("invalid JSON-RPC envelope")
    if "method" in ret:
        if not isinstance(ret["method"], str) or not ret["method"]:
            raise ProtocolError("invalid JSON-RPC method")
    elif "id" not in ret or ("result" in ret) == ("error" in ret):
        raise ProtocolError("invalid JSON-RPC response")
    if "id" in ret and ret["id"] is not None and type(ret["id"]) not in (int, str):
        raise ProtocolError("invalid JSON-RPC identifier")
    return ret


def dump(message: dict) -> bytes:
    return json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode() + b"\n"
