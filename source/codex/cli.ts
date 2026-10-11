import { resolveCli, startCli, cliError } from "../cli";
import type { CliContext, CliHandle, ProviderCLI } from "../cli";
import { asNumber, asRecord, asString } from "../parse";
import { ConnectionState, UsageError } from "../usage";
import type { UsageReport } from "../usage";
import { parseRateLimits } from "./usage";

const CLIENT_NAME = "devinBetterACP";
const CLIENT_TITLE = "Devin Better ACP";
const READ_ARGS = ["app-server", "--stdio"];

export const codexCLI: ProviderCLI = {
    readUsage: async (config, context, signal) =>
    {
        const resolution = resolveCli({
            name: "codex",
            configuredPath: config.path,
            workspacePaths: context.workspacePaths,
            environment: context.environment,
            home: context.home,
        });
        if ("error" in resolution)
            throw new UsageError(ConnectionState.MissingCli, resolution.error);
        return readUsage(resolution.path, context, signal);
    },
};

async function readUsage(
    command: string,
    context: CliContext,
    signal: AbortSignal,
): Promise<UsageReport>
{
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    let nextId = 1;
    let handle: CliHandle | undefined;

    const rejectPending = (error: Error): void =>
    {
        for (const entry of pending.values())
            entry.reject(error);
        pending.clear();
    };

    handle = startCli({
        command,
        args: READ_ARGS,
        cwd: context.workingDirectory,
        timeoutMs: 30000,
        onLine: (line) =>
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
                handle?.write(`${JSON.stringify({ id, error: { code: -32601, message: "Unsupported request" } })}\n`);
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
        },
    }, signal);
    const process = handle;
    void process.result.then((result) =>
    {
        if (pending.size > 0)
            rejectPending(cliError(result, "Codex app-server"));
    });

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

    try
    {
        await request("initialize", {
            clientInfo: { name: CLIENT_NAME, title: CLIENT_TITLE, version: context.clientVersion },
        });
        process.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
        const accountPromise = request("account/read", { refreshToken: false });
        const limitsPromise = request("account/rateLimits/read");
        const [account, limits] = await Promise.all([accountPromise, limitsPromise]);
        assertChatGptAccount(account);
        return parseRateLimits(limits);
    }
    finally
    {
        process.terminate();
        await process.result;
    }
}

function assertChatGptAccount(result: unknown): void
{
    const record = asRecord(result);
    const account = asRecord(record?.account);
    if (account === undefined)
        throw new UsageError(ConnectionState.AuthRequired, "Codex is not signed in. Run `codex login`, then retry.");
    if (asString(account.type) !== "chatgpt")
        throw new UsageError(ConnectionState.Unsupported, "Codex must be signed in with a ChatGPT account.");
}

function classifyRpcError(error: Record<string, unknown>): UsageError
{
    const code = asNumber(error.code);
    const message = asString(error.message) ?? "";
    if (code === -32601 || /method not found|not supported|unknown method/i.test(message))
    {
        return new UsageError(
            ConnectionState.Unsupported,
            "Codex app-server does not support a required read request.",
        );
    }
    if (/auth|login|sign in/i.test(message))
    {
        return new UsageError(
            ConnectionState.AuthRequired,
            "Codex needs a ChatGPT login. Run `codex login`, then retry.",
        );
    }
    return new UsageError(ConnectionState.Unavailable, "Codex app-server could not read subscription usage.");
}

