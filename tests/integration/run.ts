import * as assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import * as vscode from "vscode";

import { ConnectionState } from "../../source/usage";
import type { ExtensionApi } from "../../source/extension";

const COMMANDS = [
    "devinBetterACP.showUsage",
    "devinBetterACP.refreshAll",
    "devinBetterACP.retry",
    "devinBetterACP.configureCli",
    "devinBetterACP.openSettings",
    "devinBetterACP.openChatGptUsage",
];

export async function run(): Promise<void>
{
    const extension = vscode.extensions.getExtension("cet.devin-better-acp");
    assert.ok(extension !== undefined, "the Devin Better ACP extension is installed");
    const api = await extension.activate() as ExtensionApi;
    assert.ok(api !== undefined, "the extension exposes its status API");

    const commands = await vscode.commands.getCommands(true);
    for (const command of COMMANDS)
        assert.ok(commands.includes(command), `${command} is registered`);

    await vscode.commands.executeCommand("devinBetterACP.refreshAll");
    await waitFor(() => api.statuses().every((status) => status.state === ConnectionState.Ready), 30000);

    const statuses = api.statuses();
    assert.equal(statuses.length, 2);
    const codex = statuses.find((status) => status.provider === "codex");
    const antigravity = statuses.find((status) => status.provider === "antigravity");
    assert.ok(codex !== undefined && antigravity !== undefined);
    assert.deepEqual(codex.snapshot?.pools.map((pool) => pool.id), ["codex"]);
    assert.deepEqual(antigravity.snapshot?.pools.map((pool) => pool.id), ["gemini", "other"]);
    assert.ok((codex.snapshot?.pools[0]?.windows.length ?? 0) >= 2);

    const resultFile = process.env.DEVIN_BETTER_ACP_RESULT_FILE;
    if (resultFile !== undefined)
        writeFileSync(resultFile, `${JSON.stringify({ ok: true, statuses: statuses.length })}\n`);
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void>
{
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline)
    {
        if (predicate())
            return;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Timed out waiting for the extension host state");
}
