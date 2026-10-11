from source.mcp.channel import Channel

from .mcp import attach_integration, merge_mcp_servers
from .presentation.appearance import AGENT_TITLE, SessionAppearance, decorate_modes
from .presentation.models import ModelPicker
from .presentation.questions import QuestionCalls
from .presentation.reads import ReadProgress
from .presentation.tools import ToolPresentation

import threading
from pathlib import Path
from typing import Callable


VERSION = "0.6.0"


class Translator:
    def __init__(
        self,
        send: Callable,
        spoof_zed: bool = False,
        devin_config: bool = False,
    ):
        self.send = send
        self.spoof_zed = spoof_zed
        self.devin_config = devin_config
        self.lock = threading.Lock()
        self.pending: dict[int | str, tuple[str, str | None]] = {}
        self.prompt_sessions: dict[int | str, str] = {}
        self.cancelled_prompts: set[int | str] = set()
        self.form_elicitation: bool | None = None
        self.appearance = SessionAppearance()
        self.models = ModelPicker()
        self.questions = QuestionCalls()
        self.tool_presentation = ToolPresentation(self.questions)
        self.read_progress = ReadProgress()
        self.integration = Channel(send, self.questions.record_answers)
        self.integration_script = Path(__file__).resolve().parents[1] / "mcp/server.py"

    def from_client(self, message: dict) -> bool | None:
        method = message.get("method")
        if method is None:
            if self.integration.complete(message):
                return None
            update = self.read_progress.update(message)
            if update is not None:
                self.send(update)
            return False
        parameters = message.get("params")
        if not isinstance(parameters, dict):
            return False
        request_id = message.get("id")
        session_id = parameters.get("sessionId")
        if request_id is not None:
            with self.lock:
                self.pending[request_id] = (method, session_id if isinstance(session_id, str) else None)
                if method == "session/prompt" and isinstance(session_id, str):
                    self.prompt_sessions[request_id] = session_id
        hook = CLIENT_HOOKS.get(method)
        return hook(self, parameters, request_id) if hook is not None else False

    def initialize(self, parameters: dict, request_id: object) -> bool:
        capabilities = parameters.get("clientCapabilities")
        elicitation = capabilities.get("elicitation") if isinstance(capabilities, dict) else None
        self.form_elicitation = isinstance(elicitation, dict) and isinstance(elicitation.get("form"), dict)
        if not self.spoof_zed:
            return False
        info = parameters.get("clientInfo")
        info = dict(info) if isinstance(info, dict) else {}
        info["name"] = "zed"
        info.setdefault("version", VERSION)
        parameters["clientInfo"] = info
        return True

    def session_new(self, parameters: dict, request_id: object) -> bool:
        ret = False
        if self.devin_config:
            ret = bool(merge_mcp_servers(parameters))
        if self.form_elicitation is not None:
            ret = attach_integration(
                parameters,
                request_id,
                self.integration,
                self.integration_script,
                self.form_elicitation,
            ) or ret
        return ret

    def session_prompt(self, parameters: dict, request_id: object) -> bool:
        title = self.appearance.title(parameters)
        if title is not None:
            self.send(title)
        return False

    def session_cancel(self, parameters: dict, request_id: object) -> bool:
        session_id = parameters.get("sessionId")
        if not isinstance(session_id, str):
            return False
        with self.lock:
            self.cancelled_prompts.update(request_id for request_id, active in self.prompt_sessions.items()
                                          if active == session_id)
        self.integration.cancel(session_id)
        return False

    def set_config_option(self, parameters: dict, request_id: object) -> bool:
        return self.models.provider_value(parameters)

    def from_agent(self, message: dict) -> bool | None:
        method = message.get("method")
        if method is None:
            return self.session_response(message)
        parameters = message.get("params")
        if not isinstance(parameters, dict):
            return False
        if method == "fs/read_text_file":
            update = self.read_progress.update(message)
            if update is not None:
                self.send(update)
        elif method == "session/request_permission":
            tool = parameters.get("toolCall")
            if isinstance(tool, dict):
                return self.tool_presentation.update(parameters.get("sessionId"), tool, permission=True)
        elif method == "session/update":
            return self.session_update(message, parameters)
        return False

    def session_response(self, message: dict) -> bool:
        request_id = message.get("id")
        with self.lock:
            method, session_id = self.pending.pop(request_id, (None, None))
            prompt_session = self.prompt_sessions.pop(request_id, None)
            self.cancelled_prompts.discard(request_id)
            turn_finished = method == "session/prompt" and prompt_session not in self.prompt_sessions.values()
        result = message.get("result")
        result_session = result.get("sessionId") if isinstance(result, dict) else None
        self.integration.bind(
            request_id, result_session if isinstance(result_session, str) else None, "error" in message,
        )
        if turn_finished and prompt_session is not None:
            self.integration.cancel(prompt_session)
            self.tool_presentation.clear_session(prompt_session)
            self.read_progress.clear_session(prompt_session)
            self.appearance.clear(prompt_session)
        result = message.get("result")
        if not isinstance(result, dict):
            return False
        ret = decorate_modes(result)
        if method in ("session/new", "session/load", "session/resume", "session/set_config_option"):
            result_session = result.get("sessionId")
            ret = self.models.update(
                result, result_session if isinstance(result_session, str) else session_id,
            ) or ret
        if method == "initialize":
            info = result.get("agentInfo")
            info = dict(info) if isinstance(info, dict) else {}
            info["title"] = AGENT_TITLE
            version = info.get("version")
            info["version"] = f"{version}+devin-shim-{VERSION}" if isinstance(version, str) else VERSION
            result["agentInfo"] = info
            if self.devin_config:
                metadata = result.setdefault("_meta", {})
                if isinstance(metadata, dict):
                    metadata.setdefault("mcpConfigPath", str(Path.home() / ".config/devin/mcp_config.json"))
            ret = True
        return ret

    def session_update(self, message: dict, parameters: dict) -> bool | None:
        update = parameters.get("update")
        session_id = parameters.get("sessionId")
        if not isinstance(update, dict):
            return False
        variant = update.get("sessionUpdate")
        if variant == "config_option_update":
            models = self.models.update(update, session_id)
            return decorate_modes(update) or models
        if variant == "session_info_update" and isinstance(session_id, str):
            self.appearance.observe(session_id)
        if variant == "agent_message_chunk":
            content = update.get("content")
            if isinstance(content, dict) and content.get("type") == "text":
                if content.get("text") == "The request was cancelled by the client.":
                    with self.lock:
                        cancelled = any(self.prompt_sessions.get(request_id) == session_id
                                        for request_id in self.cancelled_prompts)
                    if cancelled:
                        return None
        if variant not in ("tool_call", "tool_call_update"):
            return False
        ret = self.tool_presentation.update(session_id, update)
        if variant == "tool_call" and update.get("kind") == "read":
            if "client_view_file" in str(update.get("title", "")):
                self.send(message)
                completed = self.read_progress.update(message)
                if completed is not None:
                    self.send(completed)
                return None
        if variant == "tool_call_update" and update.get("status") in ("completed", "failed"):
            self.read_progress.update(message)
        return ret


CLIENT_HOOKS = {
    "initialize": Translator.initialize,
    "session/new": Translator.session_new,
    "session/load": Translator.session_new,
    "session/prompt": Translator.session_prompt,
    "session/cancel": Translator.session_cancel,
    "session/set_config_option": Translator.set_config_option,
}
