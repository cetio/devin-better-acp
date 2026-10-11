from .prompt import launch_copy
from .protocol import ProtocolError, decode_frame, dump, read_frame
from .translate import Translator

import os
import signal
import subprocess
import sys
import threading
import time
from contextlib import nullcontext
from pathlib import Path
from typing import BinaryIO


KILL_GRACE_SECONDS = 2


class Bridge:
    def __init__(
        self,
        server: Path,
        server_args: list[str],
        spoof_zed: bool = False,
        devin_config: bool = False,
        system_prompt: bool = False,
    ):
        self.server = server
        self.server_args = server_args
        self.system_prompt = system_prompt
        self.stopped = threading.Event()
        self.client_closed = threading.Event()
        self.agent_closed = threading.Event()
        self.failure: str | None = None
        self.lock = threading.Lock()
        self.interrupted = False
        self.process: subprocess.Popen | None = None
        self.client_out: BinaryIO | None = None
        self.out_lock = threading.Lock()
        self.translation = Translator(self.send_message, spoof_zed, devin_config)

    def fail(self, message: str) -> None:
        with self.lock:
            if self.failure is None:
                self.failure = message
        self.stopped.set()

    def interrupt(self, signum: int, frame: object) -> None:
        self.interrupted = True
        self.stopped.set()

    def send_message(self, message: dict) -> None:
        self.send_client(dump(message))

    def send_client(self, frame: bytes) -> None:
        with self.out_lock:
            if self.client_out is not None:
                try:
                    self.client_out.write(frame if frame.endswith(b"\n") else frame + b"\n")
                    self.client_out.flush()
                except (OSError, ValueError):
                    self.stopped.set()

    def from_client(self, frame: bytes) -> bytes | None:
        message = decode_frame(frame)
        changed = self.translation.from_client(message)
        return None if changed is None else (dump(message) if changed else frame)

    def from_agent(self, frame: bytes) -> bytes | None:
        message = decode_frame(frame)
        changed = self.translation.from_agent(message)
        return None if changed is None else (dump(message) if changed else frame)

    def copy_client(self, process: subprocess.Popen) -> None:
        try:
            with os.fdopen(os.dup(sys.stdin.fileno()), "rb") as source:
                while (frame := read_frame(source)) is not None:
                    forwarded = self.from_client(frame)
                    if forwarded is not None:
                        process.stdin.write(forwarded if forwarded.endswith(b"\n") else forwarded + b"\n")
                        process.stdin.flush()
        except ProtocolError as error:
            self.fail(str(error))
        except (OSError, ValueError):
            if process.poll() is None:
                self.fail("client transport closed unexpectedly")
        finally:
            self.client_closed.set()
            try:
                process.stdin.close()
            except OSError:
                pass

    def copy_agent(self, process: subprocess.Popen) -> None:
        try:
            while (frame := read_frame(process.stdout)) is not None:
                forwarded = self.from_agent(frame)
                if forwarded is not None:
                    self.send_client(forwarded)
        except ProtocolError as error:
            self.fail(str(error))
        except (OSError, ValueError):
            self.fail("agent transport closed unexpectedly")
        finally:
            self.agent_closed.set()
            self.stopped.set()

    def drain_stderr(self, process: subprocess.Popen) -> None:
        while process.stderr.read(8192):
            pass

    def run(self) -> int:
        try:
            with launch_copy(self.server) if self.system_prompt else nullcontext(self.server) as server:
                environment = dict(os.environ)
                if self.system_prompt:
                    harness = self.server.parent / (
                        "localharness_external.exe" if os.name == "nt" else "localharness_external"
                    )
                    if harness.is_file():
                        environment.setdefault("ANTIGRAVITY_HARNESS_PATH", str(harness))
                return self.run_server(server, environment)
        except ValueError as error:
            print(f"Antigravity ACP shim: {error}.", file=sys.stderr)
            return 1
        except OSError as error:
            print(f"Antigravity ACP shim: cannot prepare server (errno {error.errno}).", file=sys.stderr)
            return 1

    def run_server(self, server: Path, environment: dict[str, str]) -> int:
        try:
            process = subprocess.Popen(
                [str(server), *self.server_args],
                cwd=self.server.parent,
                env=environment,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                start_new_session=os.name == "posix",
            )
        except OSError as error:
            print(f"Antigravity ACP shim: cannot start server (errno {error.errno}).", file=sys.stderr)
            return 1
        self.process = process
        self.client_out = os.fdopen(os.dup(sys.stdout.fileno()), "wb")
        client = threading.Thread(target=self.copy_client, args=(process,), daemon=True)
        agent = threading.Thread(target=self.copy_agent, args=(process,), daemon=True)
        stderr = threading.Thread(target=self.drain_stderr, args=(process,), daemon=True)
        previous = {signum: signal.signal(signum, self.interrupt) for signum in (signal.SIGINT, signal.SIGTERM)}
        client.start()
        agent.start()
        stderr.start()
        deadline = None
        try:
            while not self.stopped.wait(0.05) and process.poll() is None:
                if self.client_closed.is_set():
                    if deadline is None:
                        deadline = time.monotonic() + KILL_GRACE_SECONDS
                    elif time.monotonic() >= deadline:
                        break
            if self.agent_closed.is_set() and self.failure is None:
                try:
                    process.wait(timeout=KILL_GRACE_SECONDS)
                except subprocess.TimeoutExpired:
                    self.fail("server closed stdout without exiting")
            code = process.poll()
        finally:
            stop_child(process)
            self.translation.integration.close()
            agent.join(timeout=KILL_GRACE_SECONDS)
            stderr.join(timeout=KILL_GRACE_SECONDS)
            for signum, handler in previous.items():
                signal.signal(signum, handler)
        if self.failure is not None:
            print(f"Antigravity ACP shim: {self.failure}.", file=sys.stderr)
            return 1
        if code not in (None, 0):
            print(f"Antigravity ACP shim: server exited with code {code}.", file=sys.stderr)
            return 1
        if code is None and not self.client_closed.is_set() and not self.interrupted:
            print("Antigravity ACP shim: server stopped unexpectedly.", file=sys.stderr)
            return 1
        return 0


def signal_child(process: subprocess.Popen, force: bool) -> None:
    try:
        if os.name == "posix":
            os.killpg(process.pid, signal.SIGKILL if force else signal.SIGTERM)
        elif process.poll() is None:
            if force:
                process.kill()
            else:
                process.terminate()
    except ProcessLookupError:
        pass


def stop_child(process: subprocess.Popen) -> None:
    signal_child(process, False)
    try:
        process.wait(timeout=KILL_GRACE_SECONDS)
    except subprocess.TimeoutExpired:
        signal_child(process, True)
        process.wait()
    finally:
        signal_child(process, True)
