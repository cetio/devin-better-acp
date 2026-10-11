import assert from "node:assert/strict";
import { test } from "node:test";

import { ConnectionState } from "../../source/usage";
import type { AntigravityLaunchSettings } from "../../source/antigravity/config";

class FakeStatusItem
{
    text = "";
    tooltip: unknown;
    backgroundColor: unknown;
    accessibilityInformation: unknown;
    name = "";
    command: unknown;
    visible = false;

    show(): void
    {
        this.visible = true;
    }

    hide(): void
    {
        this.visible = false;
    }

    dispose(): void
    {
        this.visible = false;
    }
}

async function flush(): Promise<void>
{
    for (let i = 0; i < 5; i++)
        await new Promise((resolve) => setImmediate(resolve));
}

test(
    "extension reads settings through provider config and synchronizes only Antigravity launch options",
    async (context) =>
{
    const loader = require("node:module") as {
        _load: (request: string, parent: unknown, isMain: boolean) => unknown;
    };
    const originalLoad = loader._load;
    const configurationValues: Record<string, unknown> = {
        "codex.enabled": false,
        "antigravity.enabled": false,
        "antigravity.spoofZed": true,
        "antigravity.devinMcp": true,
        "antigravity.systemPrompt": true,
    };
    const configurationListeners: Array<(event: { affectsConfiguration: (section: string) => boolean }) => void> = [];
    const commands = new Map<string, (...argumentsList: unknown[]) => unknown>();
    const statusItems: FakeStatusItem[] = [];
    const subscriptions: Array<{ dispose: () => void }> = [];
    const writes: Array<{ settings: AntigravityLaunchSettings; path: string }> = [];
    const host = {
        StatusBarAlignment: { Left: 1, Right: 2 },
        ConfigurationTarget: { Global: 1 },
        ThemeIcon: class
        {
            constructor(readonly id: string)
            {
            }
        },
        ThemeColor: class
        {
            constructor(readonly id: string)
            {
            }
        },
        MarkdownString: class
        {
            constructor(readonly value: string)
            {
            }
        },
        QuickPickItemKind: { Default: 0, Separator: -1 },
        QuickInputButtons: { Back: { tooltip: "Back" } },
        Uri: { parse: (value: string) => value },
        env: { openExternal: async () => undefined },
        workspace: {
            isTrusted: true,
            workspaceFolders: [],
            onDidGrantWorkspaceTrust: () => ({ dispose: () => undefined }),
            onDidChangeConfiguration: (callback: typeof configurationListeners[number]) =>
            {
                configurationListeners.push(callback);
                return { dispose: () => undefined };
            },
            getConfiguration: () => ({
                get: (key: string) => configurationValues[key],
                inspect: (key: string) => ({ globalValue: configurationValues[key] }),
                update: async (key: string, value: unknown) =>
                {
                    configurationValues[key] = value;
                },
            }),
        },
        window: {
            createStatusBarItem: () =>
            {
                const item = new FakeStatusItem();
                statusItems.push(item);
                return item;
            },
            showWarningMessage: async () => undefined,
            showInformationMessage: async () => undefined,
            showErrorMessage: async () => undefined,
            showQuickPick: async () => undefined,
            showOpenDialog: async () => undefined,
        },
        commands: {
            registerCommand: (name: string, callback: (...argumentsList: unknown[]) => unknown) =>
            {
                commands.set(name, callback);
                return { dispose: () => commands.delete(name) };
            },
            executeCommand: async () => undefined,
        },
    };
    const replacement = loader._load.bind(loader);
    loader._load = (request, parent, isMain) => request === "vscode" ? host : replacement(request, parent, isMain);
    const configModule = require("../../source/antigravity/config") as typeof import("../../source/antigravity/config");
    const originalWriter = configModule.writeAntigravityLaunchSettings;
    configModule.writeAntigravityLaunchSettings = async (settings, path) =>
    {
        writes.push({ settings, path: path ?? "" });
    };
    const extension = require("../../source/extension") as typeof import("../../source/extension");
    context.after(() =>
    {
        configModule.writeAntigravityLaunchSettings = originalWriter;
        loader._load = originalLoad;
        for (const subscription of subscriptions)
            subscription.dispose();
    });

    const extensionContext = {
        globalStorageUri: { fsPath: "/tmp/devin-better-acp-extension-test" },
        extensionUri: { fsPath: "/tmp/devin-better-acp-extension" },
        extension: { packageJSON: { version: "1.2.0" } },
        subscriptions,
    } as unknown as import("vscode").ExtensionContext;
    const api = extension.activate(extensionContext);
    await flush();

    assert.deepEqual(
        api.statuses().map((status) => status.state),
        [ConnectionState.Disabled, ConnectionState.Disabled],
    );
    assert.equal(commands.has("devinBetterACP.showUsage"), true);
    assert.equal(commands.has("devinBetterACP.retry"), true);
    assert.equal(statusItems.length, 2);
    assert.deepEqual(writes.at(-1)?.settings, { spoofZed: true, devinMcp: true, systemPrompt: true });
    assert.ok(writes.at(-1)?.path.endsWith("/.config/devin/devin-better-antigravity.json"));

    configurationValues["antigravity.spoofZed"] = false;
    configurationValues["antigravity.devinMcp"] = false;
    configurationListeners[0]?.({ affectsConfiguration: (section) => section === "devinBetterACP" });
    await flush();
    assert.deepEqual(writes.at(-1)?.settings, { spoofZed: false, devinMcp: false, systemPrompt: true });

    await commands.get("devinBetterACP.refreshAll")?.();
    assert.deepEqual(
        api.statuses().map((status) => status.state),
        [ConnectionState.Disabled, ConnectionState.Disabled],
    );
});
