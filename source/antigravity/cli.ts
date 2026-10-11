import { resolveCli, runCli, cliError } from "../cli";
import { ConnectionState, UsageError } from "../usage";
import { parseUsageReport } from "./usage";
import type { ProviderCLI } from "../cli";

const READ_ARGS = ["--print", "/usage", "--output-format", "json", "--print-timeout", "20s", "--mode", "plan"];
export const antigravityCLI: ProviderCLI = {
    readUsage: async (config, context, signal) =>
    {
        const resolution = resolveCli({
            name: "agy",
            configuredPath: config.path,
            workspacePaths: context.workspacePaths,
            environment: context.environment,
            home: context.home,
        });
        if ("error" in resolution)
            throw new UsageError(ConnectionState.MissingCli, resolution.error);

        const result = await runCli({
            command: resolution.path,
            args: READ_ARGS,
            cwd: context.workingDirectory,
            timeoutMs: 30000,
        }, signal);
        if (result.failure !== undefined || result.code !== 0)
        {
            if (/auth|login|credential|signed in/i.test(result.stderr))
                throw new UsageError(ConnectionState.AuthRequired, "Antigravity CLI is not signed in. Run `agy`, sign in, then retry.");
            throw cliError(result, "Antigravity CLI");
        }
        let payload: unknown;
        try
        {
            payload = JSON.parse(result.stdout);
        }
        catch
        {
            throw new UsageError(ConnectionState.Unsupported, "Antigravity CLI returned an unreadable usage report.");
        }
        return parseUsageReport(payload);
    },
};

