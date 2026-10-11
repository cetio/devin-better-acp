from source.mcp.common import IntegrationError
from source.mcp.questions import build_question_form

import threading


def form_questions(parameters: dict) -> list[dict]:
    schema = parameters.get("requestedSchema")
    properties = schema.get("properties") if isinstance(schema, dict) else None
    if not isinstance(properties, dict) or not 1 <= len(properties) <= 4:
        return []
    ret: list[dict] = []
    for index in range(1, len(properties) + 1):
        field = properties.get(f"question_{index}")
        if not isinstance(field, dict):
            return []
        multiple = field.get("type") == "array"
        choices = field.get("items") if multiple else field
        labels = choices.get("enum") if isinstance(choices, dict) else None
        text = field.get("description")
        header = field.get("title")
        if not isinstance(labels, list) or not all(isinstance(label, str) for label in labels):
            return []
        if not isinstance(text, str) or not isinstance(header, str):
            return []
        ret.append({
            "question": text,
            "header": header,
            "options": [label for label in labels if label != "Other"],
            "allow_multiple": multiple,
        })
    return ret


def question_answers(parameters: dict, result: object) -> list[dict]:
    if not isinstance(result, dict):
        return []
    metadata = result.get("_meta")
    content = result.get("content") if result.get("action") == "accept" else (
        metadata.get("cognition.ai/partialContent") if isinstance(metadata, dict) else None
    )
    if not isinstance(content, dict):
        return []
    ret: list[dict] = []
    for index, question in enumerate(form_questions(parameters)):
        value = content.get(f"question_{index + 1}")
        values = value if question["allow_multiple"] and isinstance(value, list) else [value]
        selected = [value for value in values if isinstance(value, str) and value in question["options"]]
        custom = [value for value in values
                  if isinstance(value, str) and value not in question["options"] and value.strip()]
        if selected or custom:
            answer = {"question_index": index, "selected_options": selected}
            if custom:
                answer["other_text"] = "\n".join(custom)
            ret.append(answer)
    return ret


class QuestionCalls:
    def __init__(self):
        self.lock = threading.Lock()
        self.calls: dict[tuple[str, str], dict] = {}

    def observe(self, session_id: str, tool_id: str, arguments: dict) -> bool:
        try:
            form, _ = build_question_form({"questions": arguments["questions"]})
        except (IntegrationError, KeyError):
            return False
        questions = form_questions(form)
        if not questions:
            return False
        with self.lock:
            self.calls.setdefault((session_id, tool_id), {"questions": questions})
        return True

    def metadata(self, session_id: str, tool_id: str) -> dict:
        with self.lock:
            state = self.calls.get((session_id, tool_id))
            if state is None:
                return {}
            ret = {
                "cognition.ai/inferenceToolName": "ask_user_question",
                "cognition.ai/questions": state["questions"],
            }
            if "answers" in state:
                ret["cognition.ai/answers"] = state["answers"]
                ret["cognition.ai/originalQuestions"] = state["questions"]
            return ret

    def record_answers(self, session_id: str, parameters: dict, result: object) -> None:
        questions = form_questions(parameters)
        if not questions:
            return
        with self.lock:
            matches = [state for (active_session, tool_id), state in self.calls.items()
                       if active_session == session_id and state["questions"] == questions and "answers" not in state]
            if len(matches) == 1:
                matches[0]["answers"] = question_answers(parameters, result)

    def finish(self, session_id: str, tool_id: str) -> None:
        with self.lock:
            self.calls.pop((session_id, tool_id), None)

    def clear_session(self, session_id: str) -> None:
        with self.lock:
            for key in list(self.calls):
                if key[0] == session_id:
                    self.calls.pop(key)
