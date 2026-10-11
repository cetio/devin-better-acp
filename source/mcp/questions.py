from .common import IntegrationError

import json
from typing import Callable


def question_tool_schema() -> dict:
    return {
        "type": "object",
        "properties": {"questions": {
            "type": "array",
            "minItems": 1,
            "maxItems": 4,
            "items": {
                "type": "object",
                "properties": {
                    "question": {"type": "string", "minLength": 1, "maxLength": 5000},
                    "header": {"type": "string", "minLength": 1, "maxLength": 16},
                    "options": {
                        "type": "array",
                        "minItems": 2,
                        "maxItems": 4,
                        "items": {
                            "type": "object",
                            "properties": {
                                "label": {"type": "string", "minLength": 1, "maxLength": 200},
                                "description": {"type": "string", "maxLength": 1000},
                            },
                            "required": ["label"],
                            "additionalProperties": False,
                        },
                    },
                    "multi_select": {"type": "boolean"},
                },
                "required": ["question", "header", "options"],
                "additionalProperties": False,
            },
        }},
        "required": ["questions"],
        "additionalProperties": False,
    }


def build_question_form(arguments: object) -> tuple[dict, list[dict]]:
    if not isinstance(arguments, dict) or set(arguments) != {"questions"}:
        raise IntegrationError("Provide one to four questions")
    questions = arguments["questions"]
    if not isinstance(questions, list) or not 1 <= len(questions) <= 4:
        raise IntegrationError("Provide one to four questions")
    properties: dict[str, dict] = {}
    ret: list[dict] = []
    messages: list[str] = []
    for index, question in enumerate(questions, 1):
        if not isinstance(question, dict) or set(question) - {"question", "header", "options", "multi_select"}:
            raise IntegrationError("Each question needs question text, a header, and options")
        text = question.get("question")
        header = question.get("header")
        options = question.get("options")
        multiple = question.get("multi_select", False)
        if not isinstance(text, str) or not text.strip() or len(text) > 5000:
            raise IntegrationError("Each question needs 1 to 5000 characters of question text")
        if not isinstance(header, str) or not header.strip() or len(header) > 16:
            raise IntegrationError("Each question header must contain 1 to 16 characters")
        if not isinstance(options, list) or not 2 <= len(options) <= 4 or not isinstance(multiple, bool):
            raise IntegrationError("Each question needs two to four options and a boolean multi_select")
        labels: list[str] = []
        descriptions: list[str] = []
        for option in options:
            if not isinstance(option, dict) or set(option) - {"label", "description"}:
                raise IntegrationError("Each option needs a label and optional description")
            label = option.get("label")
            description = option.get("description", "")
            if not isinstance(label, str) or not label.strip() or len(label) > 200:
                raise IntegrationError("Each option label must contain 1 to 200 characters")
            if not isinstance(description, str) or len(description) > 1000:
                raise IntegrationError("Each option description must contain at most 1000 characters")
            if label in labels or label == "Other":
                raise IntegrationError("Option labels must be unique; Other is supplied automatically")
            labels.append(label)
            descriptions.append(f"{label}: {description}" if description else label)
        field = f"question_{index}"
        choices = {"type": "string", "enum": [*labels, "Other"]}
        properties[field] = {
            **({"type": "array", "items": choices, "uniqueItems": True} if multiple else choices),
            "title": header,
            "description": text,
        }
        ret.append({"question": text, "header": header, "field": field, "options": labels, "multi_select": multiple})
        messages.append(f"{index}. {header}: {text}\n" + "\n".join(descriptions))
    return {
        "mode": "form",
        "message": "The agent needs your input.\n\n" + "\n\n".join(messages),
        "requestedSchema": {"type": "object", "properties": properties, "required": list(properties)},
        "_meta": {"cognition.ai/allowOther": True, "cognition.ai/otherOptionValue": "Other"},
    }, ret


def render_question_answers(content: object, questions: list[dict]) -> dict:
    if not isinstance(content, dict):
        raise IntegrationError("The client returned invalid question answers")
    ret: list[dict] = []
    for question in questions:
        answer = content.get(question["field"])
        if answer is None:
            ret.append({"question": question["question"], "skipped": True})
            continue
        if question["multi_select"]:
            if not isinstance(answer, list) or any(not isinstance(value, str) or not value.strip() for value in answer):
                raise IntegrationError("The client returned an invalid multi-select answer")
        elif not isinstance(answer, str) or not answer.strip():
            raise IntegrationError("The client returned an invalid answer")
        ret.append({"question": question["question"], "answer": answer})
    return {"answers": ret}


def ask_user_question(arguments: object, request: Callable | None) -> dict:
    if request is None:
        raise IntegrationError("The local integration bridge is unavailable")
    parameters, questions = build_question_form(arguments)
    response = request("elicitation/create", parameters)
    action = response.get("action")
    if action not in ("accept", "decline", "cancel"):
        raise IntegrationError("The client returned an invalid question action")
    metadata = response.get("_meta")
    content = response.get("content") if action == "accept" else (
        metadata.get("cognition.ai/partialContent", {}) if isinstance(metadata, dict) else {}
    )
    ret = render_question_answers(content, questions)
    ret["action"] = action
    return {"content": [{"type": "text", "text": json.dumps(ret, ensure_ascii=False)}]}
