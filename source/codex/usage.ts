import { CliProcess } from "../process/runner";
import { compareWindows, durationLabel } from "../allowance/format";
import { ConnectionState, MetadataEntry, UsagePool, UsageWindow } from "../allowance/model";
import {
    AdapterError,
    AdapterResult,
    ProviderAdapter,
    ProviderInvocation,
    classifyExit,
    probeVersion,
} from "./adapter";
import { asNumber, asRecord, asString } from "./envelope";

const CLIENT_NAME = "devinBetterACP";
const CLIENT_TITLE = "Devin Better ACP";
const MAX_STDOUT_BYTES = 1024 * 1024;

export function createCodexAdapter(invocation: ProviderInvocation, clientVersion: string): ProviderAdapter
{
    return {
        id: "codex",
        label: "Codex",
        command: invocation.command,
        readArgs: invocation.readArgs,
        minimumVersion: undefined,
        version: (signal) => probeVersion(invocation, signal),
        read: (signal) => readUsage(invocation, clientVersion, signal),
    };
}

async function readUsage(
    invocation: ProviderInvocation,
    clientVersion: string,
    signal: AbortSignal,
): Promise<AdapterResult>
{
    const process = CliProcess.start({
        command: invocation.command,
        args: invocation.readArgs,
        cwd: invocation.cwd,
        timeoutMs: invocation.timeoutMs,
        maxStdoutBytes: MAX_STDOUT_BYTES,
    }, signal);
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    let nextId = 1;

    const rejectPending = (error: AdapterError): void =>
    {
        for (const entry of pending.values())
            entry.reject(error);
        pending.clear();
    };

    const request = (method: string, params?: unknown): Promise<unknown> =>
    {
        const id = nextId++;
        return new Promise<unknown>((resolve, reject) =>
        {
            pending.set(id, { resolve, reject });
            const message = params === undefined ? { method, id } : { method, id, params };
            process.write(`${JSON.stringify(message)}\n`);
        });
    };

    process.onLine((line) =>
    {
        if (line.trim().length === 0)
            return;
        let parsed: unknown;
        try
        {
            parsed = JSON.parse(line);
        }
        catch
        {
            return;
        }
        const message = asRecord(parsed);
        if (message === undefined)
            return;
        const id = asNumber(message.id);
        const method = asString(message.method);
        if (id === undefined)
            return;
        if (method !== undefined && !("result" in message) && !("error" in message))
        {
            process.write(`${JSON.stringify({ id, error: { code: -32601, message: "Unsupported request" } })}\n`);
            return;
        }
        const entry = pending.get(id);
        if (entry === undefined)
            return;
        pending.delete(id);
        const error = asRecord(message.error);
        if (error !== undefined)
            entry.reject(classifyRpcError(error));
        else
            entry.resolve(message.result);
    });
    process.onExit((exit) => rejectPending(classifyExit(exit, "Codex app-server")));

    try
    {
        await request("initialize", { clientInfo: { name: CLIENT_NAME, title: CLIENT_TITLE, version: clientVersion } });
        process.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
        const accountPromise = request("account/read", { refreshToken: false });
        const limitsPromise = request("account/rateLimits/read");
        const [account, limits] = await Promise.all([accountPromise, limitsPromise]);
        assertChatGptAccount(account);
        return parseRateLimits(limits, Date.now());
    }
    finally
    {
        process.terminate();
    }
}

function assertChatGptAccount(result: unknown): void
{
    const record = asRecord(result);
    const account = asRecord(record?.account);
    if (account === undefined)
        throw new AdapterError(ConnectionState.AuthRequired, "Codex is not signed in. Run `codex login`, then retry.");
    const type = asString(account.type);
    if (type !== "chatgpt")
    {
        const method = type ?? "an unknown method";
        const detail = `Codex is signed in with ${method}; subscription allowance requires a ChatGPT login.`;
        throw new AdapterError(ConnectionState.Unsupported, detail);
    }
}

function classifyRpcError(error: Record<string, unknown>): AdapterError
{
    const code = asNumber(error.code);
    const message = asString(error.message) ?? "Codex app-server returned an error.";
    if (code === -32601 || /method not found|not supported|unknown method/i.test(message))
        return new AdapterError(ConnectionState.Unsupported, message);
    if (/auth|login|sign in/i.test(message))
    {
        const detail = "Codex needs a ChatGPT login. Run `codex login`, then retry.";
        return new AdapterError(ConnectionState.AuthRequired, detail);
    }
    return new AdapterError(ConnectionState.Unavailable, message);
}

export function parseRateLimits(result: unknown, observedAt: number): AdapterResult
{
    const record = asRecord(result);
    if (record === undefined)
        throw new AdapterError(ConnectionState.Unsupported, "Codex returned an unexpected rate-limit response.");
    const pools: UsagePool[] = [];
    const byId = asRecord(record.rateLimitsByLimitId);
    if (byId !== undefined && Object.keys(byId).length > 0)
    {
        for (const [key, value] of Object.entries(byId))
        {
            const pool = parsePool(key, value);
            if (pool !== undefined)
                pools.push(pool);
        }
    }
    else
    {
        const pool = parsePool("codex", record.rateLimits);
        if (pool !== undefined)
            pools.push(pool);
    }
    if (pools.length === 0)
        throw new AdapterError(ConnectionState.Unsupported, "Codex reported no usable rate-limit windows.");
    pools.sort((left, right) => poolRank(left.id) - poolRank(right.id) || left.id.localeCompare(right.id));
    return { observedAt, pools, metadata: parseMetadata(record) };
}

function parsePool(key: string, value: unknown): UsagePool | undefined
{
    const entry = asRecord(value);
    if (entry === undefined)
        return undefined;
    const id = asString(entry.limitId) ?? key;
    const windows: UsageWindow[] = [];
    const primary = parseWindow(id, "primary", entry.primary);
    if (primary !== undefined)
        windows.push(primary);
    const secondary = parseWindow(id, "secondary", entry.secondary);
    if (secondary !== undefined)
        windows.push(secondary);
    if (windows.length === 0)
        return undefined;
    windows.sort(compareWindows);
    return { id, label: poolLabel(id, asString(entry.limitName)), description: undefined, windows };
}

function parseWindow(poolId: string, position: string, value: unknown): UsageWindow | undefined
{
    const record = asRecord(value);
    if (record === undefined)
        return undefined;
    const usedPercent = asNumber(record.usedPercent);
    if (usedPercent === undefined || usedPercent < 0)
        return undefined;
    const duration = asNumber(record.windowDurationMins);
    const durationMinutes = duration !== undefined && duration > 0 ? duration : undefined;
    const resetsAtSeconds = asNumber(record.resetsAt);
    return {
        id: `${poolId}:${position}`,
        label: durationMinutes === undefined ? position : durationLabel(durationMinutes),
        usedPercent,
        durationMinutes,
        resetsAt: resetsAtSeconds !== undefined && resetsAtSeconds > 0 ? resetsAtSeconds * 1000 : undefined,
    };
}

function parseMetadata(record: Record<string, unknown>): MetadataEntry[]
{
    const entry = defaultLimitRecord(record);
    if (entry === undefined)
        return [];
    const metadata: MetadataEntry[] = [];
    const plan = asString(entry.planType);
    if (plan !== undefined)
        metadata.push({ label: "Plan", value: capitalize(plan) });
    const credits = asRecord(entry.credits);
    if (credits !== undefined)
    {
        if (credits.unlimited === true)
            metadata.push({ label: "Extra credits", value: "Unlimited" });
        else if (credits.hasCredits === true)
            metadata.push({ label: "Extra credits", value: asString(credits.balance) ?? "Available" });
        else
            metadata.push({ label: "Extra credits", value: "None" });
    }
    const reached = asString(entry.rateLimitReachedType);
    if (reached !== undefined)
        metadata.push({ label: "Limit reached", value: capitalize(reached) });
    if (entry.spendControlReached === true)
        metadata.push({ label: "Spend control", value: "Reached" });
    const resets = asRecord(record.rateLimitResetCredits);
    const availableCount = resets === undefined ? undefined : asNumber(resets.availableCount);
    if (availableCount !== undefined && availableCount >= 0)
        metadata.push({ label: "Rate-limit resets available", value: String(availableCount) });
    return metadata;
}

function defaultLimitRecord(record: Record<string, unknown>): Record<string, unknown> | undefined
{
    const direct = asRecord(record.rateLimits);
    if (direct !== undefined)
        return direct;
    const byId = asRecord(record.rateLimitsByLimitId);
    return byId === undefined ? undefined : asRecord(byId.codex);
}

function poolRank(id: string): number
{
    if (id === "codex")
        return 0;
    return 1;
}

function poolLabel(id: string, limitName: string | undefined): string
{
    if (limitName !== undefined)
        return limitName;
    if (id === "codex")
        return "Codex";
    return capitalize(id.replace(/[_-]+/g, " "));
}

function capitalize(text: string): string
{
    if (text.length === 0)
        return text;
    return `${text[0]?.toUpperCase() ?? ""}${text.slice(1)}`;
}
