import { isExecutableFile, resolveCli } from "./process/discovery";
import { normalizeSettings, refreshIntervalMs, staleAfterMs, UsageSettings } from "./settings";
import { UsageController } from "./monitor";
import { Diagnostics } from "./diagnostics";
import { DisplayContext } from "./status/display";
import { PROVIDER_SPECS } from "./registry";
import { UsagePicker } from "./picker/view";
import { StatusBarView } from "./status/items";
import { ProviderId, ProviderStatus } from "./allowance/model";
import { ProviderSetup } from "./adapter";

import * as vscode from "vscode";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage?tab=overview";
const SETTINGS_QUERY = "@ext:cet.devin-better-acp";
const TIME_TICK_MS = 60000;
const VERSION_TIMEOUT_MS = 10000;
const UNTRUSTED_MESSAGE = "Trust this workspace to enable usage monitoring.";

export type ExtensionApi = {
    refreshAll: () => Promise<void>;
    statuses: () => ProviderStatus[];
};

export function activate(context: vscode.ExtensionContext): ExtensionApi
{
    const storage = ensureStorage(join(context.globalStorageUri.fsPath, "work"));
    const diagnostics = new Diagnostics();
    let settings = readSettings();

    const controller = new UsageController({
        intervalMs: refreshIntervalMs(settings),
        now: () => Date.now(),
        random: Math.random,
        setTimeout: (callback, delayMs) =>
        {
            const handle = setTimeout(callback, delayMs);
            handle.unref();
            return { cancel: () => clearTimeout(handle) };
        },
        onDidChange: () => render(),
        onRefresh: (info) => diagnostics.note(info),
    });
    const view = new StatusBarView(settings.alignment, settings.visibility);
    const picker = new UsagePicker({
        refreshAll: () => controller.refreshAll({ manual: true }),
        refreshProvider: (provider) => controller.refresh(provider, { manual: true }),
        retry: (provider) => controller.refresh(provider, { manual: true }),
        configureCli: (provider) => void configureCli(provider),
        openSettings: () => void vscode.commands.executeCommand("workbench.action.openSettings", SETTINGS_QUERY),
        showDiagnostics: () => diagnostics.show(controller.getStatuses(), displayContext()),
        openChatGptUsage: () => void vscode.env.openExternal(vscode.Uri.parse(CHATGPT_USAGE_URL)),
        setEnabled: (provider, enabled) => void updateSetting(`${provider}.enabled`, enabled),
    });

    function displayContext(): DisplayContext
    {
        return { now: Date.now(), staleAfterMs: staleAfterMs(settings) };
    }

    function render(): void
    {
        const statuses = controller.getStatuses();
        view.update(statuses, displayContext());
        picker.update(statuses, displayContext());
    }

    function buildSetups(): ProviderSetup[]
    {
        const workspacePaths = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
        return PROVIDER_SPECS.map((spec) =>
        {
            const providerSettings = settings.providers[spec.id];
            if (!providerSettings.enabled)
            {
                return {
                    provider: spec.id,
                    label: spec.label,
                    enabled: false,
                    adapter: undefined,
                    message: undefined,
                };
            }
            const resolution = resolveCli({
                name: spec.command,
                configuredPath: providerSettings.path,
                workspacePaths,
                environment: process.env,
                home: homedir(),
            });
            if ("error" in resolution)
            {
                return {
                    provider: spec.id,
                    label: spec.label,
                    enabled: true,
                    adapter: undefined,
                    message: resolution.error,
                };
            }
            const invocation = {
                command: resolution.path,
                readArgs: spec.readArgs,
                versionArgs: ["--version"],
                cwd: storage,
                timeoutMs: spec.timeoutMs,
                versionTimeoutMs: VERSION_TIMEOUT_MS,
            };
            return {
                provider: spec.id,
                label: spec.label,
                enabled: true,
                adapter: spec.create(invocation, clientVersion(context)),
                message: undefined,
            };
        });
    }

    if (!vscode.workspace.isTrusted)
        controller.setPaused(UNTRUSTED_MESSAGE);
    controller.configure(buildSetups());
    controller.setFocused(vscode.window.state.focused);
    render();

    const tick = setInterval(() =>
    {
        if (controller.getStatuses().some((status) => status.snapshot !== undefined))
            render();
    }, TIME_TICK_MS);
    tick.unref();

    context.subscriptions.push(
        vscode.workspace.onDidGrantWorkspaceTrust(() => controller.setPaused(undefined)),
        vscode.window.onDidChangeWindowState((state) => controller.setFocused(state.focused)),
        vscode.workspace.onDidChangeConfiguration((event) =>
        {
            if (!event.affectsConfiguration("devinBetterACP"))
                return;
            settings = readSettings();
            view.setAlignment(settings.alignment);
            view.setVisibility(settings.visibility);
            controller.updateInterval(refreshIntervalMs(settings));
            controller.configure(buildSetups());
            render();
        }),
        vscode.commands.registerCommand("devinBetterACP.showUsage", (focus?: unknown) =>
        {
            picker.show(controller.getStatuses(), displayContext(), parseFocus(focus));
        }),
        vscode.commands.registerCommand("devinBetterACP.refreshAll", async () =>
        {
            await controller.refreshAll({ manual: true });
            render();
        }),
        vscode.commands.registerCommand("devinBetterACP.retry", async (provider?: unknown) =>
        {
            const target = await resolveProvider(provider);
            if (target === undefined)
                return;
            await controller.refresh(target, { manual: true });
            render();
        }),
        vscode.commands.registerCommand("devinBetterACP.configureCli", async (provider?: unknown) =>
        {
            const target = await resolveProvider(provider);
            if (target !== undefined)
                await configureCli(target);
        }),
        vscode.commands.registerCommand("devinBetterACP.openSettings", () =>
        {
            void vscode.commands.executeCommand("workbench.action.openSettings", SETTINGS_QUERY);
        }),
        vscode.commands.registerCommand("devinBetterACP.showDiagnostics", () =>
        {
            diagnostics.show(controller.getStatuses(), displayContext());
        }),
        vscode.commands.registerCommand("devinBetterACP.openChatGptUsage", () =>
        {
            void vscode.env.openExternal(vscode.Uri.parse(CHATGPT_USAGE_URL));
        }),
        {
            dispose: () =>
            {
                clearInterval(tick);
                controller.dispose();
                picker.dispose();
                view.dispose();
                diagnostics.dispose();
            },
        },
    );

    return {
        refreshAll: () => controller.refreshAll({ manual: true }),
        statuses: () => controller.getStatuses(),
    };
}

function readSettings(): UsageSettings
{
    const configuration = vscode.workspace.getConfiguration("devinBetterACP");
    return normalizeSettings({
        codexEnabled: configuration.get("codex.enabled"),
        codexPath: configuration.get("codex.path"),
        antigravityEnabled: configuration.get("antigravity.enabled"),
        antigravityPath: configuration.get("antigravity.path"),
        refreshIntervalSeconds: configuration.get("refreshIntervalSeconds"),
        alignment: configuration.get("statusBar.alignment"),
        showCodex: configuration.get("statusBar.showCodex"),
        showGemini: configuration.get("statusBar.showGemini"),
        showOther: configuration.get("statusBar.showOther"),
    });
}

function clientVersion(context: vscode.ExtensionContext): string
{
    const version = context.extension.packageJSON.version;
    return typeof version === "string" ? version : "0.0.0";
}

async function resolveProvider(value: unknown): Promise<ProviderId | undefined>
{
    if (value === "codex" || value === "antigravity")
        return value;
    const picked = await vscode.window.showQuickPick(
        [
            { label: "Codex", provider: "codex" as ProviderId },
            { label: "Antigravity", provider: "antigravity" as ProviderId },
        ],
        { title: "Devin Better ACP", placeHolder: "Select a provider" },
    );
    return picked?.provider;
}

async function configureCli(provider: ProviderId): Promise<void>
{
    const spec = PROVIDER_SPECS.find((candidate) => candidate.id === provider);
    if (spec === undefined)
        return;
    const picked = await vscode.window.showOpenDialog({
        title: `Select the ${spec.label} CLI executable`,
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

function parseFocus(value: unknown): { provider: ProviderId; poolId: string } | undefined
{
    if (typeof value !== "object" || value === null)
        return undefined;
    const record = value as Record<string, unknown>;
    if ((record.provider === "codex" || record.provider === "antigravity") && typeof record.poolId === "string")
        return { provider: record.provider, poolId: record.poolId };
    return undefined;
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
