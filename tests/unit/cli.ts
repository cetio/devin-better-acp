import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

class CountingSignal extends EventTarget implements AbortSignal
{
    readonly aborted = false;
    readonly reason: unknown = undefined;
    onabort: ((this: AbortSignal, event: Event) => unknown) | null = null;
    removed = false;

    throwIfAborted(): void
    {
    }

    override removeEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | EventListenerOptions,
    ): void
    {
        if (type === "abort")
            this.removed = true;
        super.removeEventListener(type, listener, options);
    }
}

import { CliFailure, resolveCli, runCli, startCli } from "../../source/cli";
import { tempDir, writeScript } from "../support";

const SLEEP_SCRIPT = `
setTimeout(() => process.exit(0), 5000);
`;

const LINES_SCRIPT = `
process.stdout.write("alpha\\nbeta\\ngamma");
`;

type ResolveOptions = {
    configuredPath?: string;
    workspacePaths?: string[];
    path?: string;
    home: string;
};

function resolve(name: string, options: ResolveOptions): ReturnType<typeof resolveCli>
{
    return resolveCli({
        name,
        configuredPath: options.configuredPath ?? "",
        workspacePaths: options.workspacePaths ?? [],
        environment: options.path === undefined ? {} : { PATH: options.path },
        home: options.home,
    });
}

function removeDirectory(path: string): void
{
    rmSync(path, { recursive: true, force: true });
}

test("configured CLI paths must be absolute executable files", (context) =>
{
    const directory = tempDir("devin-better-acp-cli-");
    context.after(() => removeDirectory(directory));
    const script = writeScript(directory, "tool.cjs", "process.exit(0);\n");
    const plain = join(directory, "plain.txt");
    writeFileSync(plain, "not a program");

    const relative = resolve("tool", { configuredPath: "./tool", home: directory });
    assert.ok("error" in relative && relative.error.includes("absolute"));

    const missing = resolve("tool", { configuredPath: join(directory, "missing"), home: directory });
    assert.ok("error" in missing && missing.error.includes("executable"));

    const notExecutable = resolve("tool", { configuredPath: plain, home: directory });
    assert.ok("error" in notExecutable && notExecutable.error.includes("executable"));

    const resolved = resolve("tool", { configuredPath: script, home: directory });
    assert.ok("path" in resolved && resolved.path === script);
});

test("CLI discovery ignores relative and workspace PATH entries", (context) =>
{
    const directory = tempDir("devin-better-acp-cli-");
    context.after(() => removeDirectory(directory));
    const home = join(directory, "home");
    const bin = join(directory, "bin");
    const workspace = join(directory, "workspace");
    writeScript(bin, "tool.cjs", "process.exit(0);\n");
    writeScript(workspace, "tool.cjs", "process.exit(0);\n");

    const found = resolve("tool.cjs", { path: `${bin}:relative`, home });
    assert.ok("path" in found && found.path === join(bin, "tool.cjs"));

    const blocked = resolve("tool.cjs", { workspacePaths: [workspace], path: workspace, home });
    assert.ok("error" in blocked);

    const localBin = join(home, ".local", "bin");
    writeScript(localBin, "tool.cjs", "process.exit(0);\n");
    const fallback = resolve("tool.cjs", { workspacePaths: [workspace], path: "", home });
    assert.ok("path" in fallback && fallback.path === join(localBin, "tool.cjs"));
});

test("CLI discovery treats paths beginning with two dots as workspace children", (context) =>
{
    const directory = tempDir("devin-better-acp-cli-");
    context.after(() => removeDirectory(directory));
    const home = join(directory, "home");
    const workspace = join(directory, "workspace");
    const nestedBin = join(workspace, "..tools");
    writeScript(nestedBin, "tool.cjs", "process.exit(0);\n");

    const blocked = resolve("tool.cjs", { workspacePaths: [workspace], path: nestedBin, home });
    assert.ok("error" in blocked);
});

test("a captured CLI run returns stdout and its exit code", async (context) =>
{
    const directory = tempDir("devin-better-acp-cli-");
    context.after(() => removeDirectory(directory));
    const script = writeScript(directory, "lines.cjs", LINES_SCRIPT);
    const result = await runCli({ command: script, args: [], cwd: directory, timeoutMs: 5000 });

    assert.equal(result.code, 0);
    assert.equal(result.failure, undefined);
    assert.equal(result.stdout, "alpha\nbeta\ngamma");
});

test("a streamed CLI reports CRLF, fragmented, and final partial lines", async (context) =>
{
    const directory = tempDir("devin-better-acp-cli-");
    context.after(() => removeDirectory(directory));
    const script = writeScript(directory, "lines.cjs", `
process.stdout.write(Buffer.from([0xf0, 0x9f]));
setTimeout(() => process.stdout.write(Buffer.from([0x8c, 0x8d, 0x0d, 0x0a, 0x66, 0x69, 0x6e, 0x61, 0x6c])), 10);
`);
    const lines: string[] = [];
    const result = await runCli({
        command: script,
        args: [],
        cwd: directory,
        timeoutMs: 5000,
        onLine: (line) => lines.push(line),
    });

    assert.equal(result.failure, undefined);
    assert.equal(result.stdout, "");
    assert.deepEqual(lines, ["\u{1f30d}", "final"]);
});

test("a hanging CLI is terminated and reaped by its timeout", async (context) =>
{
    const directory = tempDir("devin-better-acp-cli-");
    context.after(() => removeDirectory(directory));
    const script = writeScript(directory, "sleep.cjs", SLEEP_SCRIPT);
    const handle = startCli({ command: script, args: [], cwd: directory, timeoutMs: 300 });
    const pid = handle.pid;
    const result = await handle.result;

    assert.equal(result.failure, CliFailure.Timeout);
    assert.ok(pid !== undefined);
    assert.equal(processIsRunning(pid), false);
});

test("a CLI that spawns a child has its whole group terminated", async (context) =>
{
    const directory = tempDir("devin-better-acp-cli-");
    context.after(() => removeDirectory(directory));
    const marker = join(directory, "marker.txt");
    const childCode = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x'), 1200)`;
    const script = writeScript(directory, "parent.cjs", `
const { spawn } = require("node:child_process");
spawn(process.execPath, ["-e", ${JSON.stringify(childCode)}], { stdio: "ignore" });
setTimeout(() => process.exit(0), 30000);
`);
    const handle = startCli({ command: script, args: [], cwd: directory, timeoutMs: 30000 });
    await delay(200);
    handle.terminate();
    await handle.result;
    await delay(1600);

    assert.equal(existsSync(marker), false);
});

test("output limits are byte-based and stop a CLI that exits successfully later", async (context) =>
{
    const directory = tempDir("devin-better-acp-cli-");
    context.after(() => removeDirectory(directory));
    const script = writeScript(directory, "flood.cjs", `
process.stdout.write("x".repeat(2048));
setTimeout(() => process.exit(0), 30000);
`);
    const result = await runCli({ command: script, args: [], cwd: directory, timeoutMs: 5000, maxStdoutBytes: 256 });

    assert.equal(result.failure, CliFailure.OutputLimit);
    assert.equal(result.code, null);
});

test("stderr capture is byte-bounded", async (context) =>
{
    const directory = tempDir("devin-better-acp-cli-");
    context.after(() => removeDirectory(directory));
    const script = writeScript(directory, "stderr.cjs", "process.stderr.write('ç'.repeat(100));\n");
    const result = await runCli({ command: script, args: [], cwd: directory, timeoutMs: 5000, maxStderrBytes: 17 });
    assert.ok(Buffer.byteLength(result.stderr) <= 17);
});

test("asynchronous stdin errors settle as transport failures", async (context) =>
{
    const directory = tempDir("devin-better-acp-cli-");
    context.after(() => removeDirectory(directory));
    const script = writeScript(directory, "stdin-error.cjs", `
require("node:fs").closeSync(0);
process.stdout.write("ready\\n");
setInterval(() => {}, 1000);
`);
    let resolveReady: () => void = () => undefined;
    const ready = new Promise<void>((resolve) =>
    {
        resolveReady = resolve;
    });
    const handle = startCli({
        command: script,
        args: [],
        cwd: directory,
        timeoutMs: 5000,
        onLine: (line) =>
        {
            if (line === "ready")
                resolveReady();
        },
    });
    await ready;
    handle.write("x".repeat(1024 * 1024));
    const result = await handle.result;
    assert.equal(result.failure, CliFailure.Transport);
});

test("missing executables produce a bounded start failure", async () =>
{
    const result = await runCli({
        command: "/nonexistent/devin-better-acp-tool",
        args: [],
        cwd: "/tmp",
        timeoutMs: 1000,
    });

    assert.equal(result.failure, CliFailure.Start);
    assert.equal(result.stderr, "");
});

test("aborting a CLI run terminates it", async (context) =>
{
    const directory = tempDir("devin-better-acp-cli-");
    context.after(() => removeDirectory(directory));
    const script = writeScript(directory, "sleep.cjs", SLEEP_SCRIPT);
    const controller = new AbortController();
    const running = runCli({ command: script, args: [], cwd: directory, timeoutMs: 30000 }, controller.signal);
    await delay(150);
    controller.abort();
    const result = await running;

    assert.equal(result.failure, CliFailure.Cancelled);
});

test("completed CLI runs detach their abort listener", async (context) =>
{
    const directory = tempDir("devin-better-acp-cli-");
    context.after(() => removeDirectory(directory));
    const script = writeScript(directory, "done.cjs", "process.exit(0);\n");
    const signal = new CountingSignal();

    await runCli({ command: script, args: [], cwd: directory, timeoutMs: 5000 }, signal);
    assert.equal(signal.removed, true);
});

function processIsRunning(pid: number): boolean
{
    try
    {
        process.kill(pid, 0);
        return true;
    }
    catch
    {
        return false;
    }
}
