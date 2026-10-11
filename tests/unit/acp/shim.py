import importlib.util
import io
import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
SHIM = ROOT / "bin/antigravity-acp.py"
INTEGRATION = ROOT / "bin/devin-better-integration.py"
FIXTURE = """
import json
import os
import signal
import sys
import time


def send(message):
    sys.stdout.buffer.write(json.dumps(message, ensure_ascii=False).encode() + b"\\n")
    sys.stdout.buffer.flush()


pending = None
turns = {}
for line in sys.stdin.buffer:
    message = json.loads(line)
    method = message.get("method")
    if method == "test/events":
        for event in message["params"]:
            send(event)
        send({"jsonrpc": "2.0", "id": message["id"], "result": {"stopReason": "end_turn"}})
    elif method in ("test/permission", "test/fs"):
        pending = message["id"]
        method = "session/request_permission" if method == "test/permission" else "fs/read_text_file"
        send({"jsonrpc": "2.0", "id": "approval", "method": method, "params": message["params"]})
    elif message.get("id") == "approval":
        send({"jsonrpc": "2.0", "id": pending, "result": message})
    elif method == "test/stderr":
        os.write(sys.stderr.fileno(), b"PRIVATE_PROVIDER_DETAIL\\n" * 10000)
        send({"jsonrpc": "2.0", "id": message["id"], "result": {}})
    elif method == "test/invalid":
        sys.stdout.buffer.write(b"PRIVATE_INVALID_PROVIDER_OUTPUT\\n")
        sys.stdout.buffer.flush()
    elif method == "test/exit":
        sys.exit(7)
    elif method == "test/hang":
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        send({"jsonrpc": "2.0", "id": message["id"], "result": {"pid": os.getpid()}})
        while True:
            time.sleep(1)
    elif method == "session/prompt" and message.get("params", {}).get("cancelFixture") is True:
        session_id = message["params"]["sessionId"]
        turns[session_id] = message["id"]
        send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": session_id, "update": {
            "sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "Partial response"}}}})
    elif method == "session/cancel":
        send({"jsonrpc": "2.0", "method": "test/cancelled", "params": message["params"]})
        session_id = message["params"]["sessionId"]
        if session_id in turns:
            send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": session_id, "update": {
                "sessionUpdate": "usage_update", "used": 12, "size": 100}}})
            send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": session_id, "update": {
                "sessionUpdate": "agent_message_chunk", "content": {
                    "type": "text", "text": "The request was cancelled by the client."}}}})
            send({"jsonrpc": "2.0", "id": turns.pop(session_id), "result": {"stopReason": "cancelled"}})
    else:
        result = {"request": message, "arguments": sys.argv[1:], "cwd": os.getcwd()}
        if method == "initialize":
            result["agentInfo"] = {"name": "fixture-agent", "version": "9.9.9"}
        send({"jsonrpc": "2.0", "id": message["id"], "result": result})
"""


class Probe:
    def __init__(self, fixture: Path, spoof_zed: bool = False, extra_args: list = ()):
        arguments = [
            sys.executable,
            str(SHIM),
            "--server",
            sys.executable,
        ]
        if spoof_zed:
            arguments.append("--spoof-zed")
        arguments.extend(extra_args)
        arguments.extend(["--", str(fixture), "argument with spaces"])
        self.process = subprocess.Popen(
            arguments,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self.messages = queue.Queue()
        self.reader = threading.Thread(target=self.read_stdout, daemon=True)
        self.reader.start()
        self.finished = False
        self.stderr = b""

    def read_stdout(self):
        for line in self.process.stdout:
            self.messages.put(json.loads(line))
        self.messages.put(None)

    def send(self, message):
        self.process.stdin.write(json.dumps(message, ensure_ascii=False).encode() + b"\n")
        self.process.stdin.flush()

    def receive(self):
        ret = self.messages.get(timeout=8)
        if ret is None:
            raise AssertionError("shim closed stdout before the expected response")
        return ret

    def finish(self):
        if not self.finished:
            self.process.stdin.close()
            try:
                self.process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                self.process.terminate()
                self.process.wait(timeout=8)
                raise
            finally:
                self.reader.join(timeout=2)
                self.stderr = self.process.stderr.read()
                self.process.stdout.close()
                self.process.stderr.close()
                self.finished = True
        return self.process.returncode


class ShimTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        specification = importlib.util.spec_from_file_location("antigravity_shim", SHIM)
        cls.shim = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(cls.shim)
        integration_specification = importlib.util.spec_from_file_location("devin_better_integration", INTEGRATION)
        cls.integration = importlib.util.module_from_spec(integration_specification)
        integration_specification.loader.exec_module(cls.integration)

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="acp shim ")
        self.addCleanup(self.directory.cleanup)
        self.fixture = Path(self.directory.name) / "fake.py"
        self.fixture.write_text(FIXTURE)

    def probe(self, spoof_zed=False, extra_args=()):
        ret = Probe(self.fixture, spoof_zed, extra_args)
        self.addCleanup(ret.finish)
        return ret

    def workspace(self, mcp_config=None, config=None):
        workspace = Path(self.directory.name) / "workspace"
        (workspace / ".devin").mkdir(parents=True)
        if mcp_config is not None:
            (workspace / ".devin/mcp_config.json").write_text(mcp_config)
        if config is not None:
            (workspace / ".devin/config.json").write_text(config)
        return workspace

    def session_new(self, workspace, mcp_servers=None):
        return {
            "jsonrpc": "2.0",
            "id": "session",
            "method": "session/new",
            "params": {"cwd": str(workspace), "mcpServers": mcp_servers or []},
        }

    def test_devin_config_merges_project_mcp_servers(self):
        probe = self.probe(extra_args=["--devin-config"])
        workspace = self.workspace(mcp_config="""{
            // a JSONC comment, as Devin config files allow
            "mcpServers": {
                "shim-github": { "command": "npx", "args": ["-y", "@mcp/github"], "env": { "TOKEN": "abc" } },
                "shim-remote": { "url": "https://mcp.example.com/mcp" }
            }
        }""")
        probe.send(self.session_new(workspace))
        servers = probe.receive()["result"]["request"]["params"]["mcpServers"]
        by_name = {server["name"]: server for server in servers}
        self.assertEqual(by_name["shim-github"]["command"], "npx")
        self.assertEqual(by_name["shim-github"]["env"], [{"name": "TOKEN", "value": "abc"}])
        self.assertEqual(
            by_name["shim-remote"],
            {"type": "http", "name": "shim-remote", "url": "https://mcp.example.com/mcp"},
        )

    def test_devin_config_keeps_client_servers_and_does_not_duplicate(self):
        probe = self.probe(extra_args=["--devin-config"])
        workspace = self.workspace(mcp_config='{"mcpServers": {"shim-same": {"command": "npx"}}}')
        client_server = {"name": "shim-same", "command": "from-client", "args": [], "env": []}
        probe.send(self.session_new(workspace, [client_server]))
        servers = probe.receive()["result"]["request"]["params"]["mcpServers"]
        self.assertEqual(servers.count(client_server), 1)

    def test_integration_mcp_server_requires_form_elicitation_capability(self):
        bridge = self.shim.Bridge(Path(sys.executable), [], False)
        request = self.session_new(Path(self.directory.name))
        forwarded = bridge.from_client(self.shim.dump(request))
        self.assertEqual(json.loads(forwarded)["params"], request["params"])
        self.assertIsNone(bridge.integration_server)

        initialize = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {"clientCapabilities": {"elicitation": {"form": {}}}},
        }
        bridge.from_client(self.shim.dump(initialize))
        request["id"] = 2
        forwarded = json.loads(bridge.from_client(self.shim.dump(request)))
        servers = forwarded["params"]["mcpServers"]
        entry = next(server for server in servers if server["name"] == "devin-better-integration")
        environment = {item["name"]: item["value"] for item in entry["env"]}
        self.assertEqual(entry["args"], [str(INTEGRATION), "serve"])
        self.assertTrue(Path(environment["DBA_INTEGRATION_SOCKET"]).exists())
        self.assertEqual(len(environment["DBA_INTEGRATION_TOKEN"]), 43)
        bridge.from_agent(self.shim.dump({
            "jsonrpc": "2.0", "id": 2, "result": {"sessionId": "fixture-session"},
        }))
        self.assertEqual(bridge.integration_sessions[environment["DBA_INTEGRATION_TOKEN"]], "fixture-session")
        bridge.stop_integration_server()

    def test_integration_mcp_server_respects_client_name_conflicts(self):
        bridge = self.shim.Bridge(Path(sys.executable), [], False)
        bridge.form_elicitation = True
        request = self.session_new(Path(self.directory.name), [{
            "name": "devin-better-integration", "command": "client-owned",
        }])
        request["id"] = 3
        forwarded = bridge.from_client(self.shim.dump(request))
        self.assertEqual(json.loads(forwarded)["params"], request["params"])
        self.assertIsNone(bridge.integration_server)

    def test_integration_mcp_stdio_lists_question_tool(self):
        messages = [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-11-25"}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
        ]
        completed = subprocess.run(
            [sys.executable, str(INTEGRATION), "serve"],
            input=b"".join(json.dumps(message).encode() + b"\n" for message in messages),
            capture_output=True,
            check=True,
        )
        responses = [json.loads(line) for line in completed.stdout.splitlines()]
        self.assertEqual(responses[0]["result"]["serverInfo"]["name"], "devin-better-integration")
        self.assertEqual([tool["name"] for tool in responses[1]["result"]["tools"]], ["ask_user_question"])

    def test_integration_question_round_trips_through_acp_elicitation(self):
        bridge = self.shim.Bridge(Path(sys.executable), [], False)
        self.addCleanup(bridge.stop_integration_server)
        outbound = queue.Queue()
        bridge.send_client = outbound.put
        bridge.from_client(self.shim.dump({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {"clientCapabilities": {"elicitation": {"form": {}}}},
        }))
        new_session = self.session_new(Path(self.directory.name))
        new_session["id"] = 2
        request = json.loads(bridge.from_client(self.shim.dump(new_session)))
        entry = next(server for server in request["params"]["mcpServers"]
                     if server["name"] == "devin-better-integration")
        environment = {item["name"]: item["value"] for item in entry["env"]}
        bridge.from_agent(self.shim.dump({
            "jsonrpc": "2.0", "id": 2, "result": {"sessionId": "fixture-session"},
        }))
        arguments = {"questions": [
            {
                "header": "Approach",
                "question": "Which approach should I use?",
                "options": [
                    {"label": "Simple", "description": "Keep the change small."},
                    {"label": "Broad", "description": "Make a wider improvement."},
                ],
            },
            {
                "header": "Targets",
                "question": "Which targets matter?",
                "options": [{"label": "Tests"}, {"label": "Docs"}],
                "multi_select": True,
            },
        ]}
        result_queue = queue.Queue()
        integration_bridge = self.integration.IntegrationBridge(
            environment["DBA_INTEGRATION_SOCKET"], environment["DBA_INTEGRATION_TOKEN"],
        )

        def call_integration_tool():
            result_queue.put(self.integration.handle_message({
                "jsonrpc": "2.0",
                "id": "question-call",
                "method": "tools/call",
                "params": {"name": "ask_user_question", "arguments": arguments},
            }, integration_bridge))

        worker = threading.Thread(target=call_integration_tool, daemon=True)
        worker.start()
        elicitation = json.loads(outbound.get(timeout=3))
        self.assertEqual(elicitation["method"], "elicitation/create")
        self.assertEqual(elicitation["params"]["sessionId"], "fixture-session")
        self.assertEqual(elicitation["params"]["mode"], "form")
        self.assertEqual(elicitation["params"]["requestedSchema"]["properties"]["question_1"]["enum"], [
            "Simple", "Broad", "Other",
        ])
        self.assertIsNone(bridge.from_client(self.shim.dump({
            "jsonrpc": "2.0",
            "id": elicitation["id"],
            "result": {
                "action": "accept",
                "content": {
                    "question_1": "Other",
                    "question_1_other": "Keep the current behavior",
                    "question_2_option_1": True,
                    "question_2_option_2": False,
                    "question_2_other": True,
                    "question_2_other_text": "Accessibility",
                },
            },
        })))
        result = result_queue.get(timeout=3)
        self.assertEqual(result["id"], "question-call")
        self.assertEqual(json.loads(result["result"]["content"][0]["text"]), {"answers": [
            {"question": "Which approach should I use?", "answer": "Keep the current behavior"},
            {"question": "Which targets matter?", "answer": ["Tests", "Accessibility"]},
        ]})
        worker.join(timeout=3)

    def test_devin_config_prefers_mcp_config_over_legacy_config_json(self):
        probe = self.probe(extra_args=["--devin-config"])
        workspace = self.workspace(
            mcp_config='{"mcpServers": {"shim-shared": {"command": "project"}}}',
            config='{"mcpServers": {"shim-shared": {"command": "legacy-project"}}}',
        )
        probe.send(self.session_new(workspace))
        servers = probe.receive()["result"]["request"]["params"]["mcpServers"]
        self.assertEqual(
            [server for server in servers if server["name"] == "shim-shared"],
            [{"name": "shim-shared", "command": "project", "args": [], "env": []}],
        )

    def test_devin_config_is_off_by_default(self):
        probe = self.probe()
        workspace = self.workspace(mcp_config='{"mcpServers": {"shim-off": {"command": "npx"}}}')
        request = self.session_new(workspace)
        probe.send(request)
        self.assertEqual(probe.receive()["result"]["request"], request)

    def test_devin_config_tolerates_malformed_and_hostile_config(self):
        probe = self.probe(extra_args=["--devin-config"])
        workspace = self.workspace(
            mcp_config="{ this is not json",
            config='{"mcpServers": {"shim-bad": 42, "shim-blank": {"command": ""}, '
                   '"shim-ok": {"command": "run"}, "shim-mixed": {"command": "c", "args": ["a", 7]}}}',
        )
        probe.send(self.session_new(workspace))
        servers = probe.receive()["result"]["request"]["params"]["mcpServers"]
        by_name = {server["name"]: server for server in servers}
        self.assertNotIn("shim-bad", by_name)
        self.assertNotIn("shim-blank", by_name)
        self.assertEqual(by_name["shim-ok"]["command"], "run")
        self.assertEqual(by_name["shim-mixed"]["args"], ["a"])

    def test_devin_config_skips_disabled_servers(self):
        probe = self.probe(extra_args=["--devin-config"])
        workspace = self.workspace(mcp_config=json.dumps({"mcpServers": {
            "shim-off": {"command": "npx", "disabled": True},
            "shim-off2": {"command": "npx", "enabled": False},
            "shim-on": {"command": "npx"},
        }}))
        probe.send(self.session_new(workspace))
        servers = probe.receive()["result"]["request"]["params"]["mcpServers"]
        self.assertEqual([server["name"] for server in servers], ["shim-on"])

    def test_devin_config_ignores_a_missing_workspace(self):
        probe = self.probe(extra_args=["--devin-config"])
        request = {"jsonrpc": "2.0", "id": "session", "method": "session/new", "params": {}}
        probe.send(request)
        self.assertEqual(probe.receive()["result"]["request"], request)

    def test_devin_config_leaves_session_prompt_untouched(self):
        probe = self.probe(extra_args=["--devin-config"])
        request = {
            "jsonrpc": "2.0",
            "id": 9,
            "method": "session/prompt",
            "params": {"sessionId": "s", "prompt": [{"type": "text", "text": "hello"}]},
        }
        probe.send(request)
        update = probe.receive()["params"]["update"]
        self.assertEqual(update, {"sessionUpdate": "session_info_update", "title": "hello"})
        self.assertEqual(probe.receive()["result"]["request"], request)

    def test_session_title_is_emitted_once_per_session(self):
        probe = self.probe()
        for request_id, text in ((2, "first prompt"), (3, "second prompt")):
            probe.send({
                "jsonrpc": "2.0",
                "id": request_id,
                "method": "session/prompt",
                "params": {"sessionId": "s", "prompt": [{"type": "text", "text": text}]},
            })
        update = probe.receive()
        self.assertEqual(update["method"], "session/update")
        self.assertEqual(update["params"]["update"]["title"], "first prompt")
        self.assertEqual(probe.receive()["result"]["request"]["id"], 2)
        self.assertEqual(probe.receive()["result"]["request"]["id"], 3)
        probe.send({
            "jsonrpc": "2.0",
            "id": 4,
            "method": "session/prompt",
            "params": {"sessionId": "other", "prompt": [{"type": "resource", "resource": {}}]},
        })
        self.assertEqual(probe.receive()["result"]["request"]["id"], 4)

    def test_registry_entry_carries_the_devin_config_flag(self):
        completed = subprocess.run(
            [sys.executable, str(SHIM), "--registry-entry", "--devin-config"],
            capture_output=True,
            check=True,
        )
        launch = next(iter(json.loads(completed.stdout)["distribution"]["binary"].values()))
        self.assertIn("--devin-config", launch["args"])

    def initialize(self):
        return {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": 1,
                "clientInfo": {"name": "windsurf", "title": "Devin Desktop", "version": "1.126.0"},
                "clientCapabilities": {
                    "fs": {"readTextFile": True, "writeTextFile": True},
                    "_meta": {"terminal_output": True, "cognition.ai/messageGrouping": True},
                },
            },
        }

    def test_default_identity_and_capabilities_are_unchanged(self):
        probe = self.probe()
        request = self.initialize()
        probe.send(request)
        response = probe.receive()["result"]
        self.assertEqual(response["request"], request)
        self.assertEqual(response["arguments"], ["argument with spaces"])
        self.assertEqual(response["cwd"], str(Path(sys.executable).resolve().parent))

    def test_spoof_changes_only_the_client_name(self):
        probe = self.probe(True)
        request = self.initialize()
        probe.send(request)
        request["params"]["clientInfo"]["name"] = "zed"
        self.assertEqual(probe.receive()["result"]["request"], request)

    def test_spoof_without_client_info_is_a_valid_implementation(self):
        probe = self.probe(True)
        request = self.initialize()
        del request["params"]["clientInfo"]
        probe.send(request)
        info = probe.receive()["result"]["request"]["params"]["clientInfo"]
        self.assertEqual(info, {"name": "zed", "version": self.shim.VERSION})

    def test_cwd_mcp_servers_and_extensions_are_unchanged(self):
        probe = self.probe(True)
        request = {
            "jsonrpc": "2.0",
            "id": "create-session",
            "method": "session/new",
            "params": {
                "cwd": self.directory.name,
                "mcpServers": [
                    {"name": "fixture", "command": sys.executable, "args": ["fixture.py"], "env": []},
                    {"type": "http", "name": "remote", "url": "http://localhost/mcp", "headers": []},
                ],
                "_meta": {"fixture": "résumé Ω"},
            },
        }
        probe.send(request)
        self.assertEqual(probe.receive()["result"]["request"], request)

    def test_tool_thought_plan_and_error_events_are_unchanged(self):
        probe = self.probe()
        updates = [
            {"sessionUpdate": "agent_thought_chunk", "content": {"type": "text", "text": "Thinking"}},
            {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "résumé Ω"}},
            {"sessionUpdate": "tool_call", "toolCallId": "call-1", "title": "Reading", "kind": "read",
             "status": "pending", "rawInput": {"path": "/fixture"}},
            {"sessionUpdate": "tool_call_update", "toolCallId": "call-1", "status": "completed",
             "content": [{"type": "diff", "path": "/fixture", "oldText": "old", "newText": "new"}]},
            {"sessionUpdate": "plan", "entries": [{"content": "Done", "priority": "high", "status": "completed"}]},
        ]
        events = [
            {"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": "fixture", "update": update}}
            for update in updates
        ]
        events.append({"jsonrpc": "2.0", "id": "extension", "error": {"code": -32601, "message": "unsupported"}})
        probe.send({"jsonrpc": "2.0", "id": 2, "method": "test/events", "params": events})
        received = [probe.receive() for event in events]
        for original, forwarded in zip(events, received):
            update = original.get("params", {}).get("update", {})
            if update.get("sessionUpdate") in ("tool_call", "tool_call_update"):
                forwarded = json.loads(json.dumps(forwarded))
                forwarded["params"]["update"].pop("_meta")
            self.assertEqual(forwarded, original)
        tool_call = received[2]["params"]["update"]
        self.assertEqual(tool_call["_meta"]["cognition.ai/inferenceToolName"], "read")
        self.assertEqual(probe.receive(), {"jsonrpc": "2.0", "id": 2, "result": {"stopReason": "end_turn"}})

    def test_permission_requests_and_responses_are_bidirectional(self):
        probe = self.probe()
        parameters = {
            "sessionId": "fixture",
            "toolCall": {"toolCallId": "call-1", "title": "Run fixture", "kind": "execute"},
            "options": [{"optionId": "allow", "name": "Allow once", "kind": "allow_once"}],
        }
        probe.send({"jsonrpc": "2.0", "id": 3, "method": "test/permission", "params": parameters})
        self.assertEqual(probe.receive(), {
            "jsonrpc": "2.0", "id": "approval", "method": "session/request_permission", "params": parameters,
        })
        response = {
            "jsonrpc": "2.0",
            "id": "approval",
            "result": {"outcome": {"outcome": "selected", "optionId": "allow"}},
        }
        probe.send(response)
        self.assertEqual(probe.receive()["result"], response)

    def test_file_system_requests_and_responses_are_bidirectional(self):
        probe = self.probe()
        parameters = {"sessionId": "fixture", "path": "/fixture", "line": 1, "limit": 5}
        probe.send({"jsonrpc": "2.0", "id": 8, "method": "test/fs", "params": parameters})
        self.assertEqual(probe.receive(), {
            "jsonrpc": "2.0", "id": "approval", "method": "fs/read_text_file", "params": parameters,
        })
        response = {"jsonrpc": "2.0", "id": "approval", "result": {"content": "résumé Ω"}}
        probe.send(response)
        self.assertEqual(probe.receive()["result"], response)

    def test_cancellation_is_forwarded_as_a_notification(self):
        probe = self.probe()
        parameters = {"sessionId": "fixture"}
        probe.send({"jsonrpc": "2.0", "method": "session/cancel", "params": parameters})
        self.assertEqual(probe.receive(), {"jsonrpc": "2.0", "method": "test/cancelled", "params": parameters})

    def test_cancel_boilerplate_is_suppressed_but_partial_output_and_response_survive(self):
        log = Path(self.directory.name) / "cancel.jsonl"
        probe = self.probe(extra_args=["--debug-log", str(log)])
        probe.send({
            "jsonrpc": "2.0",
            "id": "turn",
            "method": "session/prompt",
            "params": {"sessionId": "fixture", "prompt": [], "cancelFixture": True},
        })
        self.assertEqual(probe.receive()["params"]["update"]["content"]["text"], "Partial response")
        probe.send({"jsonrpc": "2.0", "method": "session/cancel", "params": {"sessionId": "fixture"}})
        self.assertEqual(probe.receive()["method"], "test/cancelled")
        self.assertEqual(probe.receive()["params"]["update"], {
            "sessionUpdate": "usage_update", "used": 12, "size": 100,
        })
        self.assertEqual(probe.receive(), {"jsonrpc": "2.0", "id": "turn", "result": {"stopReason": "cancelled"}})
        probe.send({"jsonrpc": "2.0", "id": "next", "method": "test/echo", "params": {}})
        self.assertEqual(probe.receive()["result"]["request"]["id"], "next")
        probe.finish()
        records = [json.loads(line) for line in log.read_text().splitlines()]
        self.assertTrue(any(
            record.get("dir") == "shim"
            and record.get("msg", {}).get("event") == "cancellation_message_suppressed"
            for record in records
        ))
        self.assertIn("The request was cancelled by the client.", log.read_text())

    def test_cancel_filter_is_scoped_to_an_active_prompt_and_session(self):
        for prompt_session, cancel_session, notice_session, suppressed in (
            ("active", "active", "active", True),
            ("active", "other", "active", False),
            ("active", "active", "other", False),
            (None, "idle", "idle", False),
        ):
            with self.subTest(prompt=prompt_session, cancel=cancel_session, notice=notice_session):
                bridge = self.shim.Bridge(Path(sys.executable), [], False)
                if prompt_session is not None:
                    bridge.from_client(self.shim.dump({
                        "jsonrpc": "2.0",
                        "id": 1,
                        "method": "session/prompt",
                        "params": {"sessionId": prompt_session, "prompt": []},
                    }))
                bridge.from_client(self.shim.dump({
                    "jsonrpc": "2.0", "method": "session/cancel", "params": {"sessionId": cancel_session},
                }))
                frame = self.shim.dump({
                    "jsonrpc": "2.0",
                    "method": "session/update",
                    "params": {"sessionId": notice_session, "update": {
                        "sessionUpdate": "agent_message_chunk",
                        "content": {"type": "text", "text": "The request was cancelled by the client."},
                    }},
                })
                self.assertEqual(bridge.from_agent(frame), None if suppressed else frame)

    def test_cancel_filter_preserves_other_text_and_clears_on_any_response(self):
        for response in (
            {"result": {"stopReason": "cancelled", "usage": {"inputTokens": 12}}},
            {"result": {"stopReason": "end_turn"}},
            {"result": {"stopReason": "_provider_reason"}},
            {"result": "provider-string"},
            {"result": None},
            {"error": {"code": -32000, "message": "fixture failure"}},
        ):
            with self.subTest(response=response):
                bridge = self.shim.Bridge(Path(sys.executable), [], False)
                request = self.shim.dump({
                    "jsonrpc": "2.0",
                    "id": "turn",
                    "method": "session/prompt",
                    "params": {"sessionId": "fixture", "prompt": []},
                })
                bridge.from_client(request)
                bridge.from_client(self.shim.dump({
                    "jsonrpc": "2.0", "method": "session/cancel", "params": {"sessionId": "fixture"},
                }))
                for text in ("More partial output", "Output: The request was cancelled by the client."):
                    frame = self.shim.dump({
                        "jsonrpc": "2.0",
                        "method": "session/update",
                        "params": {"sessionId": "fixture", "update": {
                            "sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": text},
                        }},
                    })
                    self.assertEqual(bridge.from_agent(frame), frame)
                completed = self.shim.dump({"jsonrpc": "2.0", "id": "turn", **response})
                self.assertEqual(bridge.from_agent(completed), completed)
                bridge.from_client(request)
                notice = self.shim.dump({
                    "jsonrpc": "2.0",
                    "method": "session/update",
                    "params": {"sessionId": "fixture", "update": {
                        "sessionUpdate": "agent_message_chunk",
                        "content": {"type": "text", "text": "The request was cancelled by the client."},
                    }},
                })
                self.assertEqual(bridge.from_agent(notice), notice)

    def test_large_stderr_is_drained_without_being_exposed(self):
        probe = self.probe()
        probe.send({"jsonrpc": "2.0", "id": 4, "method": "test/stderr", "params": {}})
        self.assertEqual(probe.receive(), {"jsonrpc": "2.0", "id": 4, "result": {}})
        self.assertEqual(probe.finish(), 0)
        self.assertEqual(probe.stderr, b"")

    def test_invalid_provider_stdout_fails_without_leaking_its_contents(self):
        probe = self.probe()
        probe.send({"jsonrpc": "2.0", "id": 5, "method": "test/invalid", "params": {}})
        self.assertNotEqual(probe.finish(), 0)
        self.assertIn(b"invalid JSON-RPC", probe.stderr)
        self.assertNotIn(b"PRIVATE", probe.stderr)
        self.assertIsNone(probe.messages.get(timeout=2))

    def test_upstream_nonzero_exit_is_visible_and_classified(self):
        probe = self.probe()
        probe.send({"jsonrpc": "2.0", "id": 6, "method": "test/exit", "params": {}})
        probe.process.wait(timeout=8)
        self.assertNotEqual(probe.finish(), 0)
        self.assertIn(b"exited with code 7", probe.stderr)
        self.assertNotIn(b"Fatal Python error", probe.stderr)

    @unittest.skipUnless(os.name == "posix", "process-group cleanup is POSIX-specific")
    def test_disconnect_kills_an_unresponsive_upstream(self):
        probe = self.probe()
        probe.send({"jsonrpc": "2.0", "id": 7, "method": "test/hang", "params": {}})
        pid = probe.receive()["result"]["pid"]
        self.assertEqual(probe.finish(), 0)
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)

    def test_frame_limit_and_json_rpc_shape_are_checked(self):
        with self.assertRaises(self.shim.ProtocolError):
            self.shim.read_frame(io.BytesIO(b"x" * 65), 64)
        for frame in (b"[]\n", b'{"jsonrpc":"1.0"}\n', b'{"jsonrpc":"2.0","result":1}\n'):
            with self.subTest(frame=frame), self.assertRaises(self.shim.ProtocolError):
                self.shim.decode_frame(frame)
        self.assertEqual(self.shim.read_frame(io.BytesIO(b"\n{\"jsonrpc\":\"2.0\",\"method\":\"fixture\"}")),
                         b'{"jsonrpc":"2.0","method":"fixture"}')

    def test_eof_drains_the_final_response(self):
        completed = subprocess.run(
            [
                sys.executable,
                str(SHIM),
                "--server",
                sys.executable,
                "--",
                str(self.fixture),
            ],
            input=json.dumps(self.initialize()).encode(),
            capture_output=True,
            check=True,
        )
        self.assertEqual(json.loads(completed.stdout)["result"]["request"], self.initialize())
        self.assertEqual(completed.stderr, b"")

    def test_invalid_client_frames_are_redacted(self):
        probe = self.probe()
        probe.process.stdin.write(b"PRIVATE_INVALID_CLIENT_FRAME\n")
        probe.process.stdin.flush()
        self.assertNotEqual(probe.finish(), 0)
        self.assertIn(b"invalid JSON-RPC", probe.stderr)
        self.assertNotIn(b"PRIVATE", probe.stderr)

    def test_registry_entry_preserves_the_current_server_symlink(self):
        server = Path(self.directory.name) / "current"
        server.symlink_to(sys.executable)
        completed = subprocess.run(
            [
                sys.executable,
                str(SHIM),
                "--registry-entry",
                "--server",
                str(server),
            ],
            capture_output=True,
            check=True,
        )
        launch = next(iter(json.loads(completed.stdout)["distribution"]["binary"].values()))
        self.assertEqual(launch["args"][2], str(server))

    def test_live_probe_requires_explicit_opt_in(self):
        completed = subprocess.run(
            [sys.executable, str(ROOT / "tests/integration/acp.py")],
            capture_output=True,
        )
        self.assertEqual(completed.returncode, 2)
        self.assertIn(b"explicitly authorized", completed.stderr)
        self.assertEqual(completed.stdout, b"")

    def test_agent_identity_marks_the_shim_in_band(self):
        probe = self.probe()
        probe.send(self.initialize())
        info = probe.receive()["result"]["agentInfo"]
        self.assertEqual(info["name"], "fixture-agent")
        self.assertEqual(info["title"], "Antigravity (DBA)")
        self.assertTrue(info["version"].endswith(f"+devin-shim-{self.shim.VERSION}"))

    def test_mcp_config_path_is_advertised_only_with_devin_config(self):
        plain = self.probe()
        plain.send(self.initialize())
        self.assertNotIn("mcpConfigPath", plain.receive()["result"].get("_meta") or {})
        merged = self.probe(extra_args=["--devin-config"])
        merged.send(self.initialize())
        path = merged.receive()["result"]["_meta"]["mcpConfigPath"]
        self.assertTrue(path.endswith(".config/devin/mcp_config.json"))

    def test_shim_command_is_advertised_and_answered_locally(self):
        probe = self.probe()
        events = [{
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "fixture",
                "update": {
                    "sessionUpdate": "available_commands_update",
                    "availableCommands": [{"name": "existing", "description": "from upstream"}],
                },
            },
        }]
        probe.send({"jsonrpc": "2.0", "id": 2, "method": "test/events", "params": events})
        update = probe.receive()["params"]["update"]
        names = [command["name"] for command in update["availableCommands"]]
        self.assertEqual(names, ["existing", self.shim.SHIM_COMMAND])
        injected = update["availableCommands"][-1]
        self.assertEqual(injected["_meta"], {"cognition.ai/category": "System"})
        self.assertEqual(probe.receive(), {"jsonrpc": "2.0", "id": 2, "result": {"stopReason": "end_turn"}})
        probe.send({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "session/prompt",
            "params": {
                "sessionId": "fixture",
                "prompt": [{"type": "text", "text": f"/{self.shim.SHIM_COMMAND}"}],
            },
        })
        chunk = probe.receive()
        self.assertEqual(chunk["method"], "session/update")
        self.assertEqual(chunk["params"]["update"]["sessionUpdate"], "agent_message_chunk")
        self.assertIn("Antigravity (DBA) shim is active", chunk["params"]["update"]["content"]["text"])
        self.assertEqual(probe.receive(), {"jsonrpc": "2.0", "id": 3, "result": {"stopReason": "end_turn"}})
        probe.send({"jsonrpc": "2.0", "id": 4, "method": "test/echo", "params": {}})
        echoed = probe.receive()["result"]["request"]
        self.assertEqual(echoed["id"], 4)
        self.assertEqual(echoed["method"], "test/echo")

    def test_execute_output_maps_to_terminal_metadata(self):
        probe = self.probe()
        events = [
            {"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": "s", "update": {
                "sessionUpdate": "tool_call", "toolCallId": "cmd-1", "kind": "execute",
                "status": "in_progress", "title": "printf hi",
                "rawInput": {"command_line": "printf hi"}}}},
            {"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": "s", "update": {
                "sessionUpdate": "tool_call_update", "toolCallId": "cmd-1", "status": "completed",
                "rawOutput": {"commandLine": "printf hi", "exitCode": 0, "exit_code": 0,
                              "combinedOutput": "hi", "formatted_output": "hi"}}}},
            {"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": "s", "update": {
                "sessionUpdate": "tool_call", "toolCallId": "read-1", "kind": "read",
                "status": "in_progress", "title": "view_file"}}},
            {"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": "s", "update": {
                "sessionUpdate": "tool_call_update", "toolCallId": "read-1", "status": "failed",
                "rawOutput": "Tool execution failed"}}},
            {"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": "s", "update": {
                "sessionUpdate": "tool_call", "toolCallId": "cmd-2", "kind": "execute",
                "status": "in_progress", "title": "bad"}}},
            {"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": "s", "update": {
                "sessionUpdate": "tool_call_update", "toolCallId": "cmd-2", "status": "failed",
                "rawOutput": "Tool execution failed"}}},
        ]
        probe.send({"jsonrpc": "2.0", "id": 2, "method": "test/events", "params": events})
        created = probe.receive()["params"]["update"]
        self.assertEqual(created["_meta"]["terminal_info"], {"terminal_id": "cmd-1"})
        self.assertEqual(created["_meta"]["cognition.ai/inferenceToolName"], "exec")
        updated = probe.receive()["params"]["update"]
        self.assertEqual(updated["_meta"]["cognition.ai/inferenceToolName"], "exec")
        self.assertEqual(updated["_meta"]["terminal_output"], {"terminal_id": "cmd-1", "data": "hi"})
        self.assertEqual(
            updated["_meta"]["terminal_exit"],
            {"terminal_id": "cmd-1", "exit_code": 0, "signal": None},
        )
        plain_read = probe.receive()["params"]["update"]
        self.assertEqual(plain_read["_meta"]["cognition.ai/inferenceToolName"], "read")
        read_update = probe.receive()["params"]["update"]
        self.assertEqual(read_update["_meta"]["cognition.ai/inferenceToolName"], "read")
        self.assertEqual(read_update["rawOutput"], "Tool execution failed")
        probe.receive()
        failed_run = probe.receive()["params"]["update"]
        self.assertEqual(
            failed_run["_meta"]["terminal_output"],
            {"terminal_id": "cmd-2", "data": "Tool execution failed"},
        )
        self.assertEqual(probe.receive(), {"jsonrpc": "2.0", "id": 2, "result": {"stopReason": "end_turn"}})

    def test_successful_host_read_completes_without_waiting_for_the_turn(self):
        for order in (("request", "tool", "result"), ("request", "result", "tool")):
            with self.subTest(order=order):
                bridge = self.shim.Bridge(Path(sys.executable), [], False)
                bridge.client_out = io.BytesIO()
                messages = {
                    "request": {"jsonrpc": "2.0", "id": "read", "method": "fs/read_text_file", "params": {
                        "sessionId": "fixture", "path": "/fixture/file.txt", "line": 2, "limit": 3,
                    }},
                    "tool": {"jsonrpc": "2.0", "method": "session/update", "params": {
                        "sessionId": "fixture", "update": {
                            "sessionUpdate": "tool_call", "toolCallId": "read-tool", "kind": "read",
                            "title": "Running client_view_file", "status": "in_progress",
                            "locations": [{"path": "/fixture/file.txt"}],
                            "_meta": {"fixture/context": True},
                        },
                    }},
                    "result": {"jsonrpc": "2.0", "id": "read", "result": {"content": "one\ntwo\nthree\n"}},
                }
                for item in order:
                    frame = self.shim.dump(messages[item])
                    if item == "result":
                        self.assertEqual(bridge.from_client(frame), frame)
                    else:
                        forwarded = bridge.from_agent(frame)
                        if forwarded is not None:
                            bridge.send_client(forwarded)
                updates = [
                    message["params"]["update"]
                    for line in bridge.client_out.getvalue().splitlines()
                    if (message := json.loads(line)).get("method") == "session/update"
                ]
                self.assertEqual(len(updates), 2)
                self.assertEqual(updates[0]["status"], "in_progress")
                self.assertEqual(updates[1]["toolCallId"], "read-tool")
                self.assertEqual(updates[1]["status"], "completed")
                self.assertEqual(updates[1]["content"], [{
                    "type": "content", "content": {"type": "text", "text": "3 lines"},
                }])
                self.assertTrue(updates[1]["_meta"]["fixture/context"])
                late = self.shim.dump({"jsonrpc": "2.0", "method": "session/update", "params": {
                    "sessionId": "fixture", "update": {
                        "sessionUpdate": "tool_call_update", "toolCallId": "read-tool",
                        "status": "failed", "rawOutput": "fixture provider failure",
                    },
                }})
                self.assertEqual(json.loads(bridge.from_agent(late))["params"]["update"]["status"], "failed")

    def test_read_progress_does_not_invent_failed_or_ambiguous_results(self):
        for response, ambiguous, title in (
            ({"error": {"code": -32000, "message": "fixture error"}}, False, "Running client_view_file"),
            ({"result": {"content": None}}, False, "Running client_view_file"),
            ({"result": {"content": "one\n"}}, True, "Running client_view_file"),
            ({"result": {"content": "one\n"}}, False, "Running view_file"),
        ):
            with self.subTest(response=response, ambiguous=ambiguous, title=title):
                bridge = self.shim.Bridge(Path(sys.executable), [], False)
                bridge.client_out = io.BytesIO()
                for request_id in ("read", "other") if ambiguous else ("read",):
                    bridge.from_agent(self.shim.dump({
                        "jsonrpc": "2.0", "id": request_id, "method": "fs/read_text_file",
                        "params": {"sessionId": "fixture", "path": "/fixture/file.txt"},
                    }))
                frame = self.shim.dump({"jsonrpc": "2.0", "method": "session/update", "params": {
                    "sessionId": "fixture", "update": {
                        "sessionUpdate": "tool_call", "toolCallId": "read-tool", "kind": "read",
                        "title": title, "status": "in_progress", "locations": [{"path": "/fixture/file.txt"}],
                    },
                }})
                forwarded = bridge.from_agent(frame)
                if forwarded is not None:
                    bridge.send_client(forwarded)
                result = self.shim.dump({"jsonrpc": "2.0", "id": "read", **response})
                self.assertEqual(bridge.from_client(result), result)
                updates = [json.loads(line) for line in bridge.client_out.getvalue().splitlines()]
                self.assertEqual(len(updates), 1)
                self.assertEqual(updates[0]["params"]["update"]["status"], "in_progress")

    def test_read_progress_is_session_scoped_and_cleared_after_the_prompt(self):
        bridge = self.shim.Bridge(Path(sys.executable), [], False)
        bridge.client_out = io.BytesIO()
        bridge.from_client(self.shim.dump({
            "jsonrpc": "2.0", "id": "turn", "method": "session/prompt",
            "params": {"sessionId": "fixture", "prompt": []},
        }))
        bridge.from_agent(self.shim.dump({
            "jsonrpc": "2.0", "id": "read", "method": "fs/read_text_file",
            "params": {"sessionId": "fixture", "path": "/fixture/file.txt"},
        }))
        frame = self.shim.dump({"jsonrpc": "2.0", "method": "session/update", "params": {
            "sessionId": "other", "update": {
                "sessionUpdate": "tool_call", "toolCallId": "read-tool", "kind": "read",
                "title": "Running client_view_file", "status": "in_progress",
                "locations": [{"path": "/fixture/file.txt"}],
            },
        }})
        forwarded = bridge.from_agent(frame)
        if forwarded is not None:
            bridge.send_client(forwarded)
        bridge.from_client(self.shim.dump({"jsonrpc": "2.0", "id": "read", "result": {"content": "one\n"}}))
        self.assertEqual(len(bridge.client_out.getvalue().splitlines()), 1)
        response = self.shim.dump({"jsonrpc": "2.0", "id": "turn", "result": {"stopReason": "end_turn"}})
        self.assertEqual(bridge.from_agent(response), response)
        self.assertNotIn(("fixture", "/fixture/file.txt"), bridge.read_calls)
        self.assertNotIn("read", bridge.read_requests)

    def test_devin_picker_model_ids_round_trip_to_provider_values(self):
        bridge = self.shim.Bridge(Path(sys.executable), [], False)
        bridge.pending["new-session"] = "session/new"
        response = {
            "jsonrpc": "2.0",
            "id": "new-session",
            "result": {
                "sessionId": "fixture",
                "configOptions": [{
                    "id": "model",
                    "category": "model",
                    "type": "select",
                    "currentValue": "gemini-3.6-flash-low",
                    "options": [
                        {"value": "gemini-3.6-flash-low", "name": "Gemini 3.6 Flash Low"},
                        {"value": "gemini-3-flash-high", "name": "Gemini 3 Flash High"},
                        {"value": "claude-opus-4.6-thinking", "name": "Claude Opus 4.6 Thinking"},
                        {"value": "gemini-pro-agent", "name": "Gemini 3.1 Pro High"},
                        {"value": "gemini-3.1-pro-low", "name": "Gemini 3.1 Pro Low"},
                        {"value": "claude-sonnet-4-6", "name": "Claude Sonnet 4.6"},
                        {"value": "gpt-oss-120b", "name": "GPT OSS 120B"},
                    ],
                }],
            },
        }
        translated = json.loads(bridge.from_agent(self.shim.dump(response)))
        option = translated["result"]["configOptions"][0]
        self.assertEqual(option["currentValue"], "gemini-3-6-flash-low")
        self.assertEqual([item["value"] for item in option["options"]], [
            "gemini-3-6-flash-low",
            "MODEL_GOOGLE_GEMINI_3_0_FLASH_HIGH",
            "claude-opus-4-6-thinking",
            "gemini-3-1-pro-high",
            "gemini-3-1-pro-low",
            "claude-sonnet-4-6-thinking",
            "gpt-oss-120b",
        ])

        request = self.shim.dump({
            "jsonrpc": "2.0",
            "id": "switch",
            "method": "session/set_config_option",
            "params": {"sessionId": "fixture", "configId": "model", "value": "gemini-3-6-flash-low"},
        })
        forwarded = json.loads(bridge.from_client(request))
        self.assertEqual(forwarded["params"]["value"], "gemini-3.6-flash-low")

        flash_request = self.shim.dump({
            "jsonrpc": "2.0",
            "id": "switch-flash",
            "method": "session/set_config_option",
            "params": {
                "sessionId": "fixture",
                "configId": "model",
                "value": "MODEL_GOOGLE_GEMINI_3_0_FLASH_HIGH",
            },
        })
        flash_forwarded = json.loads(bridge.from_client(flash_request))
        self.assertEqual(flash_forwarded["params"]["value"], "gemini-3-flash-high")

        for model_uid, provider_value in (
            ("gemini-3-1-pro-high", "gemini-pro-agent"),
            ("gemini-3-1-pro-low", "gemini-3.1-pro-low"),
            ("claude-sonnet-4-6-thinking", "claude-sonnet-4-6"),
        ):
            with self.subTest(model_uid=model_uid):
                alias_request = self.shim.dump({
                    "jsonrpc": "2.0",
                    "id": "switch-alias",
                    "method": "session/set_config_option",
                    "params": {
                        "sessionId": "fixture",
                        "configId": "model",
                        "value": model_uid,
                    },
                })
                alias_forwarded = json.loads(bridge.from_client(alias_request))
                self.assertEqual(alias_forwarded["params"]["value"], provider_value)

    def test_devin_picker_remaps_model_option_updates(self):
        bridge = self.shim.Bridge(Path(sys.executable), [], False)
        frame = self.shim.dump({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "fixture",
                "update": {
                    "sessionUpdate": "config_option_update",
                    "configOptions": [{
                        "id": "model",
                        "category": "model",
                        "type": "select",
                        "currentValue": "gemini-3.8-flash-high",
                        "options": [{"value": "gemini-3.8-flash-high", "name": "Gemini 3.8 Flash High"}],
                    }],
                },
            },
        })
        translated = json.loads(bridge.from_agent(frame))
        option = translated["params"]["update"]["configOptions"][0]
        self.assertEqual(option["currentValue"], "gemini-3-8-flash-high")
        self.assertEqual(option["options"][0]["value"], "gemini-3-8-flash-high")
        request = self.shim.dump({
            "jsonrpc": "2.0",
            "id": "switch",
            "method": "session/set_config_option",
            "params": {"sessionId": "fixture", "configId": "model", "value": "gemini-3-8-flash-high"},
        })
        forwarded = json.loads(bridge.from_client(request))
        self.assertEqual(forwarded["params"]["value"], "gemini-3.8-flash-high")

    def test_native_mode_labels_and_icons_preserve_wire_values(self):
        bridge = self.shim.Bridge(Path(sys.executable), [], False)
        payload = {
            "modes": {"currentModeId": "default", "availableModes": [
                {"id": "default", "name": "Default"},
                {"id": "auto_edit", "name": "Auto Edit"},
                {"id": "yolo", "name": "YOLO"},
            ]},
            "configOptions": [
                {"id": "model", "category": "model", "options": [{"value": "default", "name": "Fixture model"}]},
                {"id": "mode", "category": "mode", "type": "select", "currentValue": "default", "options": [
                    {"value": "default", "name": "Default"},
                    {"value": "auto_edit", "name": "Auto Edit", "_meta": {"fixture/kept": True}},
                    {"value": "yolo", "name": "YOLO"},
                    {"value": "future", "name": "Future provider mode"},
                ]},
            ],
        }
        frame = self.shim.dump({"jsonrpc": "2.0", "id": "modes", "result": payload})
        result = json.loads(bridge.from_agent(frame))["result"]
        self.assertEqual(result["modes"]["currentModeId"], "default")
        self.assertEqual([mode["id"] for mode in result["modes"]["availableModes"]], ["default", "auto_edit", "yolo"])
        self.assertEqual([mode["name"] for mode in result["modes"]["availableModes"]], [
            "Default", "Code", "Bypass Permissions",
        ])
        options = result["configOptions"][1]["options"]
        self.assertEqual([option["value"] for option in options], ["default", "auto_edit", "yolo", "future"])
        self.assertEqual([option["_meta"]["cognition.ai/icon"] for option in options[:3]], [
            "shield", "code", "shield-off",
        ])
        self.assertTrue(options[1]["_meta"]["fixture/kept"])
        self.assertEqual(options[3], payload["configOptions"][1]["options"][3])
        self.assertEqual(result["configOptions"][0], payload["configOptions"][0])
        self.assertNotIn("ask", [option["value"] for option in options])
        request = self.shim.dump({
            "jsonrpc": "2.0", "id": "switch", "method": "session/set_config_option",
            "params": {"sessionId": "fixture", "configId": "mode", "value": "yolo"},
        })
        self.assertEqual(bridge.from_client(request), request)

    def test_mode_icons_are_added_to_updates_without_overwriting_provider_icons(self):
        bridge = self.shim.Bridge(Path(sys.executable), [], False)
        frame = self.shim.dump({"jsonrpc": "2.0", "method": "session/update", "params": {
            "sessionId": "fixture", "update": {
                "sessionUpdate": "config_option_update", "configOptions": [{
                    "id": "mode", "category": "mode", "type": "select", "currentValue": "yolo",
                    "options": [{"value": "yolo", "name": "YOLO", "_meta": {"cognition.ai/icon": "provider-icon"}}],
                }],
            },
        }})
        option = json.loads(bridge.from_agent(frame))["params"]["update"]["configOptions"][0]["options"][0]
        self.assertEqual(option["name"], "Bypass Permissions")
        self.assertEqual(option["_meta"]["cognition.ai/icon"], "provider-icon")

    def test_debug_log_records_traffic_and_stderr(self):
        log = Path(self.directory.name) / "debug.jsonl"
        probe = self.probe(extra_args=["--debug", "--debug-log", str(log)])
        probe.send(self.initialize())
        probe.receive()
        probe.send({"jsonrpc": "2.0", "id": 5, "method": "test/stderr", "params": {}})
        probe.receive()
        self.assertEqual(probe.finish(), 0)
        records = [json.loads(line) for line in log.read_text().splitlines()]
        directions = [record["dir"] for record in records]
        self.assertEqual(directions.count("c2a"), 2)
        self.assertGreaterEqual(directions.count("a2c"), 2)
        self.assertIn("err", directions)
        self.assertIn("initialize", [record.get("msg", {}).get("method") for record in records])
        self.assertNotIn("PRIVATE_PROVIDER_DETAIL", log.read_text())
        self.assertTrue(any(record["dir"] == "err" and record.get("bytes", 0) > 0 for record in records))

    def test_debug_log_is_private_redacts_credentials_and_keeps_valid_bounded_jsonl(self):
        log = Path(self.directory.name) / "private-debug.jsonl"
        debug = self.shim.DebugLog(log)
        debug.write({"dir": "c2a", "msg": {
            "method": "session/new",
            "params": {
                "headers": {"Authorization": "Bearer PRIVATE_HEADER"},
                "mcpServers": [{"name": "test", "env": [{"name": "API_TOKEN", "value": "PRIVATE_ENV_TOKEN"}]}],
                "credential": "PRIVATE_CREDENTIAL",
            },
        }})
        debug.write({"dir": "a2c", "msg": {
            "method": "session/update",
            "content": "x" * (self.shim.LOG_LINE_BYTES + 1),
        }})
        debug.file.close()
        content = log.read_text()
        self.assertNotIn("PRIVATE_HEADER", content)
        self.assertNotIn("PRIVATE_ENV_TOKEN", content)
        self.assertNotIn("PRIVATE_CREDENTIAL", content)
        records = [json.loads(line) for line in content.splitlines()]
        self.assertEqual(records[1]["msg"]["event"], "frame_truncated")
        self.assertLessEqual(max(map(len, content.splitlines())), self.shim.LOG_LINE_BYTES)
        if os.name == "posix":
            self.assertEqual(log.stat().st_mode & 0o077, 0)

    def test_registry_entry_uses_an_https_icon_url(self):
        completed = subprocess.run(
            [
                sys.executable,
                str(SHIM),
                "--registry-entry",
                "--spoof-zed",
                "--",
                "--uid=",
            ],
            capture_output=True,
            check=True,
        )
        entry = json.loads(completed.stdout)
        self.assertEqual(entry["id"], "devin-better-antigravity")
        self.assertTrue(entry["icon"].startswith("https://"))
        self.assertIn("antigravity-acp.svg", entry["icon"])
        icon = (ROOT / "images/antigravity-acp.svg").read_text()
        self.assertIn('fill="#ffffff"', icon)
        self.assertNotIn("currentColor", icon)
        launch = next(iter(entry["distribution"]["binary"].values()))
        self.assertEqual(launch["cmd"], str(Path(sys.executable).absolute()))
        self.assertIn(str(SHIM), launch["args"])
        self.assertIn("--spoof-zed", launch["args"])
        self.assertEqual(launch["args"][-2:], ["--", "--uid="])
        self.assertEqual(completed.stderr, b"")


if __name__ == "__main__":
    unittest.main()
