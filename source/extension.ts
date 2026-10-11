import { installAntigravity, antigravityInstallPaths } from "./antigravity/install";
import {
    antigravityLaunchConfigPath,
    antigravityLaunchSettings,
    writeAntigravityLaunchSettings,
} from "./antigravity/config";
import type { AntigravityConfig } from "./antigravity/config";
import { isExecutableFile } from "./cli";
import { startPolling } from "./poll";
import { readExtensionConfig } from "./config";
import type { ExtensionConfig } from "./config";
import { UsageService } from "./usage";
import { UsagePicker } from "./ui/picker";
import type { PickerFocus } from "./ui/picker";
import { StatusBarView } from "./ui/status";
import type { ProviderId, ProviderStatus } from "./usage";

import * as vscode from "vscode";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage?tab=overview";
const SETTINGS_QUERY = "@ext:cet.devin-better-acp";

export type ExtensionApi = {
    refreshAll: () => Promise<void>;
    statuses: () => ProviderStatus[];
};

export function activate(context: vscode.ExtensionContext): ExtensionApi
{
    const storage = ensureStorage(join(context.globalStorageUri.fsPath, "work"));
    let settings = readExtensionConfig(vscode.workspace.getConfiguration("devinBetterACP"));
    let launchSettingsWrite: Promise<void> = Promise.resolve();

    const usage = new UsageService({
        intervalMs: settings.intervalMs,
        staleAfterMs: settings.staleAfterMs,
        trusted: vscode.workspace.isTrusted,
        now: () => Date.now(),
        context: () => ({
            workingDirectory: storage,
            workspacePaths: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
            environment: process.env,
            home: homedir(),
            clientVersion: clientVersion(context),
        }),
        schedule: startPolling,
        onDidChange: () => render(),
    });
    const view = new StatusBarView(settings.alignment, providerVisibility(settings));
    const picker = new UsagePicker({
        refreshAll: () => usage.refreshAll(),
        refreshProvider: (provider) => usage.refresh(provider),
        retry: (provider) => usage.retry(provider),
        configureCli: (provider) => void configureCli(provider),
        openSettings: () => void vscode.commands.executeCommand("workbench.action.openSettings", SETTINGS_QUERY),
        openChatGptUsage: () => void vscode.env.openExternal(vscode.Uri.parse(CHATGPT_USAGE_URL)),
        setEnabled: (provider, enabled) => void updateSetting(`${provider}.enabled`, enabled),
    });

    function render(): void
    {
        const state = usage.getState();
        view.update(state);
        picker.update(state);
    }

    function syncLaunchSettings(config: AntigravityConfig): Promise<void>
    {
        const launchSettings = antigravityLaunchSettings(config);
        const write = launchSettingsWrite.catch(() => undefined).then(() =>
            writeAntigravityLaunchSettings(launchSettings, antigravityLaunchConfigPath()));
        launchSettingsWrite = write;
        return write;
    }

    function currentAntigravityConfig(): AntigravityConfig
    {
        const provider = settings.providers.find((candidate) => candidate.id === "antigravity");
        if (provider?.id !== "antigravity")
            throw new Error("Antigravity configuration is unavailable.");
        return provider;
    }

    function queueLaunchSettingsSync(): void
    {
        void syncLaunchSettings(currentAntigravityConfig()).catch(() =>
        {
            void vscode.window.showErrorMessage("Devin Better ACP: could not save Antigravity launch settings.");
        });
    }

    queueLaunchSettingsSync();
    usage.configure(settings);
    render();

    context.subscriptions.push(
        vscode.workspace.onDidGrantWorkspaceTrust(() => usage.setTrusted(true)),
        vscode.workspace.onDidChangeConfiguration((event) =>
        {
            if (!event.affectsConfiguration("devinBetterACP"))
                return;
            settings = readExtensionConfig(vscode.workspace.getConfiguration("devinBetterACP"));
            view.setAlignment(settings.alignment);
            view.setVisibility(providerVisibility(settings));
            usage.configure(settings);
            queueLaunchSettingsSync();
            render();
        }),
        vscode.commands.registerCommand("devinBetterACP.showUsage", (focus?: unknown) =>
        {
            picker.show(usage.getState(), parseFocus(focus));
        }),
        vscode.commands.registerCommand("devinBetterACP.refreshAll", async () =>
        {
            await usage.refreshAll();
            render();
        }),
        vscode.commands.registerCommand("devinBetterACP.retry", async (provider?: unknown) =>
        {
            const target = await resolveProvider(provider, settings);
            if (target === undefined)
                return;
            await usage.retry(target);
            render();
        }),
        vscode.commands.registerCommand("devinBetterACP.configureCli", async (provider?: unknown) =>
        {
            const target = await resolveProvider(provider, settings);
            if (target !== undefined)
                await configureCli(target);
        }),
        vscode.commands.registerCommand("devinBetterACP.openSettings", () =>
        {
            void vscode.commands.executeCommand("workbench.action.openSettings", SETTINGS_QUERY);
        }),
        vscode.commands.registerCommand("devinBetterACP.openChatGptUsage", () =>
        {
            void vscode.env.openExternal(vscode.Uri.parse(CHATGPT_USAGE_URL));
        }),
        // TODO: Offer to update the ACP when it is already installed instead of only offering installation.
        vscode.commands.registerCommand("devinBetterACP.installAntigravity", async () =>
        {
            const paths = antigravityInstallPaths();
            const confirmation = await vscode.window.showWarningMessage(
                "Install Devin Better Antigravity?",
                {
                    modal: true,
                    detail: `This copies the ACP shim into ${paths.installDirectory} and updates `
                        + `${paths.registryPath}. Matching Antigravity entries will be replaced; `
                        + `unrelated entries are preserved, and the three launch options are written to `
                        + `${paths.launchConfigPath}.`,
                },
                "Install",
            );
            if (confirmation !== "Install")
                return;
            try
            {
                await syncLaunchSettings(currentAntigravityConfig());
                const installed = await installAntigravity(context.extensionUri.fsPath);
                void vscode.window.showInformationMessage(
                    `Installed Devin Better Antigravity. Run Devin: Reload ACP Connections to apply settings from `
                        + `${installed.launchConfigPath}.`,
                );
            }
            catch (error)
            {
                const detail = error instanceof Error ? error.message : "Unknown installation error.";
                void vscode.window.showErrorMessage(`Devin Better ACP: ${detail}`);
            }
        }),
        {
            dispose: () =>
            {
                usage.dispose();
                picker.dispose();
                view.dispose();
            },
        },
    );

    return {
        refreshAll: () => usage.refreshAll(),
        statuses: () => usage.getStatuses(),
    };
}

function providerVisibility(config: ExtensionConfig): Record<ProviderId, boolean>
{
    const codex = config.providers.find((provider) => provider.id === "codex");
    const antigravity = config.providers.find((provider) => provider.id === "antigravity");
    return { codex: codex?.visible ?? true, antigravity: antigravity?.visible ?? true };
}

function clientVersion(context: vscode.ExtensionContext): string
{
    const version = context.extension.packageJSON.version;
    return typeof version === "string" ? version : "0.0.0";
}

async function resolveProvider(value: unknown, config: ExtensionConfig): Promise<ProviderId | undefined>
{
    if (value === "codex" || value === "antigravity")
        return value;
    const picked = await vscode.window.showQuickPick(
        config.providers.map((provider) => ({ label: provider.label, provider: provider.id })),
        { title: "Devin Better ACP", placeHolder: "Select a provider" },
    );
    return picked?.provider;
}

async function configureCli(provider: ProviderId): Promise<void>
{
    const label = provider === "codex" ? "Codex" : "Antigravity";
    const picked = await vscode.window.showOpenDialog({
        title: `Select the ${label} CLI executable`,
        openLabel: "Use this executable",
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
    });
    const path = picked?.[0]?.fsPath;
    if (path === undefined)
        return;
    if (!isExecutableFile(path))
    {
        void vscode.window.showWarningMessage(`Devin Better ACP: ${path} is not an executable file.`);
        return;
    }
    await updateSetting(`${provider}.path`, path);
}

async function updateSetting(key: string, value: unknown): Promise<void>
{
    await vscode.workspace.getConfiguration("devinBetterACP").update(key, value, vscode.ConfigurationTarget.Global);
}

function parseFocus(value: unknown): PickerFocus | undefined
{
    if (typeof value !== "object" || value === null)
        return undefined;
    const record = value as Record<string, unknown>;
    if (record.provider !== "codex" && record.provider !== "antigravity")
        return undefined;
    if (record.poolId === undefined)
        return { provider: record.provider };
    return typeof record.poolId === "string" ? { provider: record.provider, poolId: record.poolId } : undefined;
}

function ensureStorage(path: string): string
{
    try
    {
        mkdirSync(path, { recursive: true });
        return path;
    }
    catch
    {
        return homedir();
    }
}
