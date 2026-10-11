import { CliExit, runCli } from "../process/runner";
import type { Version } from "../process/version";
import { ConnectionState, MetadataEntry, ProviderId, UsagePool } from "../allowance/model";

export type ProviderInvocation = {
    command: string;
    readArgs: string[];
    versionArgs: string[];
    cwd: string;
    timeoutMs: number;
    versionTimeoutMs: number;
};

export type AdapterResult = {
    observedAt: number;
    pools: UsagePool[];
    metadata: MetadataEntry[];
};

export type ProviderAdapter = {
    id: ProviderId;
    label: string;
    command: string;
    readArgs: string[];
    minimumVersion: Version | undefined;
    version: (signal: AbortSignal) => Promise<string>;
    read: (signal: AbortSignal) => Promise<AdapterResult>;
};

export type ProviderSetup = {
    provider: ProviderId;
    label: string;
    enabled: boolean;
    adapter: ProviderAdapter | undefined;
    message: string | undefined;
};

export class AdapterError extends Error
{
    readonly state: ConnectionState;

    constructor(state: ConnectionState, message: string)
    {
        super(message);
        this.name = "AdapterError";
        this.state = state;
    }
}

export function classifyExit(exit: CliExit, label: string): AdapterError
{
    if (exit.spawnError !== undefined)
        return new AdapterError(ConnectionState.MissingCli, `${label} could not be started (${exit.spawnError}).`);
    if (exit.timedOut)
        return new AdapterError(ConnectionState.Unavailable, `${label} timed out.`);
    if (exit.aborted)
        return new AdapterError(ConnectionState.Unavailable, `${label} was cancelled.`);
    if (exit.outputLimitExceeded)
        return new AdapterError(ConnectionState.Unsupported, `${label} returned more data than expected.`);
    return new AdapterError(ConnectionState.Unavailable, `${label} exited unexpectedly (code ${exit.code ?? "none"}).`);
}

export async function probeVersion(invocation: ProviderInvocation, signal: AbortSignal): Promise<string>
{
    const result = await runCli({
        command: invocation.command,
        args: invocation.versionArgs,
        cwd: invocation.cwd,
        timeoutMs: invocation.versionTimeoutMs,
        maxStdoutBytes: 64 * 1024,
    }, signal);
    if (result.exit.spawnError !== undefined)
        throw classifyExit(result.exit, "The CLI");
    const text = result.stdout.trim();
    if (result.exit.timedOut || result.exit.aborted || result.exit.code !== 0 || text.length === 0)
        throw classifyExit(result.exit, "The CLI version check");
    return text;
}
