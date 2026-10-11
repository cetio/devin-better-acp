from .commands import batch_execute, batch_execute_schema
from .files import (
    batch_edit,
    batch_edit_schema,
    batch_read,
    batch_read_schema,
    batch_search,
    batch_search_schema,
    batch_write,
    batch_write_schema,
)
from .questions import ask_user_question, question_tool_schema


TOOLS = {
    "ask_user_question": {
        "description": "Ask the user one to four structured questions and wait for answers. "
        "Other and skipping are supported.",
        "inputSchema": question_tool_schema(),
        "handler": ask_user_question,
    },
    "batch_edit": {
        "description": "Apply exact-text patches to up to 8 files in parallel. Each oldText must match exactly once; "
        "a file is left unchanged if any patch is missing, repeated, invalid, or exceeds 1 MiB.",
        "inputSchema": batch_edit_schema(),
        "handler": batch_edit,
    },
    "batch_execute": {
        "description": "Run up to 8 shell commands in parallel. Optional cwd and timeout (default 120s, maximum 600s). "
        "Timeout kills the process group. Output retains the last 64 KiB per stream. "
        "Returns exit_code, stdout, stderr.",
        "inputSchema": batch_execute_schema(),
        "handler": batch_execute,
    },
    "batch_read": {
        "description": "Read up to 8 text files, capped at 256 KiB each. Optional 1-based offset and line limit. "
        "Returns content, line_count for the read prefix, and truncated when capped, or per-file errors.",
        "inputSchema": batch_read_schema(),
        "handler": batch_read,
    },
    "batch_search": {
        "description": "Search up to 8 paths for literal text, with optional case, file-glob, and context filters. "
        "Each search scans at most 1000 files and 16 MiB; output is limited to 50 results per search.",
        "inputSchema": batch_search_schema(),
        "handler": batch_search,
    },
    "batch_write": {
        "description": "Write up to 8 files (1 MiB each), creating parents and overwriting existing content. "
        "Returns per-file byte counts or errors.",
        "inputSchema": batch_write_schema(),
        "handler": batch_write,
    },
}
