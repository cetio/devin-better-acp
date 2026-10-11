import { ConnectionState, UsageError } from "./usage";
import type { UsageReport } from "./usage";
import type { ProviderConfig } from "./config";

import { ChildProcess, spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join, relative, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";

const DEFAULT_MAX_STDOUT_BYTES = 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 8 * 1024;
const KILL_GRACE_MS = 2000;

export type CliContext = {
    workingDirectory: string;
    workspacePaths: string[];
    environment: NodeJS.ProcessEnv;
    home: string;
    clientVersion: string;
};

export type CliCommand = {
    command: string;
    args: string[];
    cwd: string;
    timeoutMs: number;
    maxStdoutBytes?: number;
    maxStderrBytes?: number;
    onLine?: (line: string) => void;
};

export type CliResult = {
    code: number | null;
    failure: CliFailure | undefined;
    stdout: string;
    stderr: string;
};

export enum CliFailure
{
    Start = "start",
    Timeout = "timeout",
    Cancelled = "cancelled",
    OutputLimit = "outputLimit",
    Transport = "transport",
}

export type CliHandle = {
    pid: number | undefined;
    write: (text: string) => void;
    terminate: () => void;
    result: Promise<CliResult>;
};

export type CliResolution = { path: string } | { error: string };

export type ResolveCliOptions = {
    name: string;
    configuredPath: string;
    workspacePaths: string[];
    environment: NodeJS.ProcessEnv;
    home: string;
};

export type ProviderCLI = {
    readUsage: (config: ProviderConfig, context: CliContext, signal: AbortSignal) => Promise<UsageReport>;
};

export function startCli(command: CliCommand, signal?: AbortSignal): CliHandle
{
    let child: ChildProcess;
    try
    {
        child = spawn(command.command, command.args, {
            cwd: command.cwd,
            detached: process.platform !== "win32",
            windowsHide: true,
            shell: false,
            stdio: ["pipe", "pipe", "pipe"],
        });
    }
    catch
    {
        return failedHandle(CliFailure.Start);
    }

    let failure: CliFailure | undefined;
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let lineBuffer = "";
    let timedOut = false;
    let aborted = false;
    let finished = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const decoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    const maxStdoutBytes = command.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES;
    const maxStderrBytes = command.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;

    const signalGroup = (signalName: NodeJS.Signals): void =>
    {
        if (child.pid === undefined)
            return;
        if (process.platform === "win32")
        {
            try
            {
                child.kill(signalName);
            }
            catch
            {
                return;
            }
            return;
        }
        try
        {
            process.kill(-child.pid, signalName);
        }
        catch
        {
            try
            {
                child.kill(signalName);
            }
            catch
            {
                return;
            }
        }
    };

    let resolveResult: (result: CliResult) => void = () => undefined;
    const result = new Promise<CliResult>((resolve) =>
    {
        resolveResult = resolve;
    });

    const stop = (reason?: CliFailure): void =>
    {
        if (finished)
            return;
        if (reason !== undefined && failure === undefined)
            failure = reason;
        signalGroup("SIGTERM");
        if (killTimer === undefined)
        {
            killTimer = setTimeout(() => signalGroup("SIGKILL"), KILL_GRACE_MS);
            killTimer.unref();
        }
    };

    const fail = (reason: CliFailure): void =>
    {
        if (failure !== undefined)
            return;
        failure = reason;
        signalGroup("SIGKILL");
    };

    const emitLines = (text: string, final: boolean): void =>
    {
        if (command.onLine === undefined || failure !== undefined)
            return;
        lineBuffer += text;
        let newline = lineBuffer.indexOf("\n");
        try
        {
            while (newline >= 0)
            {
                command.onLine(lineBuffer.slice(0, newline).replace(/\r$/, ""));
                lineBuffer = lineBuffer.slice(newline + 1);
                newline = lineBuffer.indexOf("\n");
            }
            if (final && lineBuffer.length > 0)
            {
                command.onLine(lineBuffer.replace(/\r$/, ""));
                lineBuffer = "";
            }
        }
        catch
        {
            fail(CliFailure.Transport);
        }
    };

    child.stdout?.on("data", (chunk: Buffer) =>
    {
        if (failure !== undefined || finished)
            return;
        stdoutBytes += chunk.length;
        if (stdoutBytes > maxStdoutBytes)
        {
            fail(CliFailure.OutputLimit);
            return;
        }
        const text = decoder.write(chunk);
        if (command.onLine === undefined)
            stdout += text;
        else
            emitLines(text, false);
    });
    child.stdout?.on("end", () => emitLines(decoder.end(), true));
    child.stderr?.on("data", (chunk: Buffer) =>
    {
        const remaining = maxStderrBytes - stderrBytes;
        if (remaining <= 0)
            return;
        const retained = chunk.subarray(0, remaining);
        stderrBytes += retained.length;
        stderr += stderrDecoder.write(retained);
    });
    child.stdin?.on("error", () => stop(CliFailure.Transport));
    child.on("error", () =>
    {
        if (failure === undefined)
            failure = CliFailure.Start;
    });

    timeoutTimer = setTimeout(() =>
    {
        timedOut = true;
        stop(CliFailure.Timeout);
    }, command.timeoutMs);
    timeoutTimer.unref();

    let abortHandler: (() => void) | undefined;
    if (signal !== undefined)
    {
        abortHandler = () =>
        {
            aborted = true;
            stop(CliFailure.Cancelled);
        };
        if (signal.aborted)
            abortHandler();
        else
            signal.addEventListener("abort", abortHandler, { once: true });
    }

    child.on("close", (code) =>
    {
        if (finished)
            return;
        finished = true;
        if (timeoutTimer !== undefined)
            clearTimeout(timeoutTimer);
        if (abortHandler !== undefined && signal !== undefined)
            signal.removeEventListener("abort", abortHandler);
        if (killTimer !== undefined)
        {
            clearTimeout(killTimer);
            signalGroup("SIGKILL");
        }
        const remainingStderr = stderrDecoder.end();
        if (Buffer.byteLength(stderr) + Buffer.byteLength(remainingStderr) <= maxStderrBytes)
            stderr += remainingStderr;
        resolveResult({
            code,
            failure: failure ?? (timedOut ? CliFailure.Timeout : aborted ? CliFailure.Cancelled : undefined),
            stdout,
            stderr,
        });
    });

    return {
        pid: child.pid,
        write: (text) =>
        {
            if (finished || child.stdin === null || child.stdin.destroyed)
                return;
            child.stdin.write(text);
        },
        terminate: () => stop(),
        result,
    };
}

export async function runCli(command: CliCommand, signal?: AbortSignal): Promise<CliResult>
{
    return startCli(command, signal).result;
}

export function cliError(result: CliResult, label: string): UsageError
{
    if (result.failure === CliFailure.Start)
        return new UsageError(ConnectionState.MissingCli, `${label} could not be started.`);
    if (result.failure === CliFailure.Timeout)
        return new UsageError(ConnectionState.Unavailable, `${label} timed out.`);
    if (result.failure === CliFailure.Cancelled)
        return new UsageError(ConnectionState.Unavailable, `${label} was cancelled.`);
    if (result.failure === CliFailure.OutputLimit)
        return new UsageError(ConnectionState.Unsupported, `${label} returned more data than expected.`);
    if (result.failure === CliFailure.Transport)
        return new UsageError(ConnectionState.Unavailable, `${label} could not complete its request.`);
    return new UsageError(ConnectionState.Unavailable, `${label} exited unexpectedly (code ${result.code ?? "none"}).`);
}

export function resolveCli(options: ResolveCliOptions): CliResolution
{
    const configured = options.configuredPath.trim();
    if (configured.length > 0)
    {
        if (!isAbsolute(configured))
            return { error: `The configured ${options.name} path must be absolute.` };
        if (!isExecutableFile(configured))
            return { error: `The configured ${options.name} path is not an executable file.` };
        return { path: configured };
    }
    const candidates: string[] = [join(options.home, ".local", "bin", options.name)];
    for (const entry of (options.environment.PATH ?? "").split(delimiter))
    {
        if (entry.length === 0 || !isAbsolute(entry) || isInsideAny(entry, options.workspacePaths))
            continue;
        candidates.push(join(entry, options.name));
    }
    for (const candidate of candidates)
    {
        if (isExecutableFile(candidate))
            return { path: candidate };
    }
    return { error: `The ${options.name} CLI was not found. Install it or set an absolute path in settings.` };
}

export function isExecutableFile(path: string): boolean
{
    try
    {
        if (!statSync(path).isFile())
            return false;
        accessSync(path, constants.X_OK);
        return true;
    }
    catch
    {
        return false;
    }
}

function failedHandle(failure: CliFailure): CliHandle
{
    return {
        pid: undefined,
        write: () => undefined,
        terminate: () => undefined,
        result: Promise.resolve({ code: null, failure, stdout: "", stderr: "" }),
    };
}

function isInsideAny(path: string, parents: string[]): boolean
{
    for (const parent of parents)
    {
        if (parent.length === 0)
            continue;
        const childPath = relative(parent, path);
        if (childPath.length === 0 || (childPath !== ".." && !childPath.startsWith(`..${sep}`) && !isAbsolute(childPath)))
            return true;
    }
    return false;
}
