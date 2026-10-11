import { ConnectionState, ProviderId, ProviderStatus } from "../../../source/allowance/model";
import {
    testAntigravityStatus,
    testPool,
    testStatus,
    testUsageState,
    testWindow,
    TEST_CONTEXT,
    TEST_NOW,
} from "../../support";
import type { PickAction, PickItem, PickerCallbacks } from "../../../source/ui/picker";

import assert from "node:assert/strict";
import { mock, test } from "node:test";

type TestItem = {
    id: string;
    label: string;
    description?: string;
    detail?: string;
    action?: PickAction;
};

type TestButton = { tooltip?: string };

class FakePicker
{
    items: TestItem[] = [];
    activeItems: TestItem[] = [];
    buttons: TestButton[] = [];
    title = "";
    placeholder = "";
    value = "";
    busy = false;
    visible = false;
    disposed = false;
    private acceptHandler: () => void = () => undefined;
    private buttonHandler: (button: TestButton) => void = () => undefined;
    private hideHandler: () => void = () => undefined;

    onDidAccept(handler: () => void): void
    {
        this.acceptHandler = handler;
    }

    onDidTriggerButton(handler: (button: TestButton) => void): void
    {
        this.buttonHandler = handler;
    }

    onDidHide(handler: () => void): void
    {
        this.hideHandler = handler;
    }

    show(): void
    {
        this.visible = true;
    }

    hide(): void
    {
        this.visible = false;
        this.hideHandler();
    }

    dispose(): void
    {
        this.disposed = true;
        this.visible = false;
    }

    accept(item: TestItem): void
    {
        this.activeItems = [item];
        this.acceptHandler();
    }

    press(button: TestButton): void
    {
        this.buttonHandler(button);
    }
}

const instances: FakePicker[] = [];
const BACK: TestButton = { tooltip: "Back" };
const host = {
    QuickPickItemKind: { Default: 0, Separator: -1 },
    QuickInputButtons: { Back: BACK },
    ThemeIcon: class
    {
        constructor(readonly id: string)
        {
        }
    },
    env: { clipboard: { writeText: async () => undefined } },
    window: {
        createQuickPick: () =>
        {
            const ret = new FakePicker();
            instances.push(ret);
            return ret;
        },
        showQuickPick: () =>
        {
            throw new Error("Details must reuse the existing picker.");
        },
        showErrorMessage: () => undefined,
    },
};
const loader = require("node:module") as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};
const load = loader._load;
const replacement = mock.method(loader, "_load", (request: string, parent: unknown, isMain: boolean) =>
{
    return request === "vscode" ? host : load(request, parent, isMain);
});
const pickerModule = require("../../../source/ui/picker") as typeof import("../../../source/ui/picker");
replacement.mock.restore();

const { UsagePicker, managementItems, pickerItems, pickerTitle } = pickerModule;

function statuses(): ProviderStatus[]
{
    return [testStatus(), testAntigravityStatus()];
}

function callbacks(): PickerCallbacks & { refreshProvider: (provider: ProviderId) => Promise<void> }
{
    return {
        refreshAll: async () => undefined,
        refreshProvider: async () => undefined,
        retry: async () => undefined,
        configureCli: () => undefined,
        openSettings: () => undefined,
        openChatGptUsage: () => undefined,
        setEnabled: () => undefined,
    };
}

function current(): FakePicker
{
    const ret = instances.at(-1);
    assert.ok(ret !== undefined);
    return ret;
}

function windowItem(picker: FakePicker): TestItem
{
    const ret = picker.items.find((item) => item.id.startsWith("window."));
    assert.ok(ret !== undefined);
    return ret;
}

function windowRows(picker: FakePicker): TestItem[]
{
    return picker.items.filter((item) => item.id.startsWith("window."));
}

test("usage rows show comparable limits while connection actions stay out of the main menu", () =>
{
    const items = pickerItems([testStatus()], TEST_CONTEXT);
    const labels = items.map((item) => item.label);
    assert.ok(labels.includes("Codex"));
    assert.ok(labels.includes("5-hour limit · 3% used"));
    assert.ok(labels.includes("Weekly limit · 16% used"));
    assert.ok(labels.includes("Plan"));
    assert.ok(labels.includes("Updated"));
    assert.ok(labels.includes("$(gear) Settings & connection…"));
    assert.equal(items.some((item) => item.action?.kind === "configureCli"), false);
    assert.equal(items.some((item) => item.action?.kind === "openChatGptUsage"), false);
    assert.equal(labels.some((label) => label.includes("remaining")), false);

    const windowItem = items.find((item) => item.id === "window.codex.codex.codex:secondary");
    assert.ok(windowItem !== undefined);
    assert.equal(windowItem.label, "Weekly limit · 16% used");
    assert.equal(windowItem.description, undefined);
    assert.equal(windowItem.action, undefined);
    assert.ok(windowItem.detail?.startsWith("Resets in 6d 6h · "));

    const updated = items.find((item) => item.id === "updated.codex");
    assert.equal(updated?.description, "just now");
    assert.equal(updated?.detail, "Codex · CLI 0.160.0");
});

test("management separates provider connections from general settings", () =>
{
    const items = managementItems([testStatus()]);
    const headings = items.filter((item) => item.kind === "separator").map((item) => item.label);
    assert.deepEqual(headings, ["Codex", "Settings"]);
    assert.ok(items.some((item) => item.action?.kind === "retry"));
    assert.ok(items.some((item) => item.action?.kind === "configureCli"));
    assert.ok(items.some((item) => item.action?.kind === "openChatGptUsage"));
});

test("picker items guide recovery for disabled and empty providers", () =>
{
    const disabled = pickerItems([testStatus({ state: ConnectionState.Disabled, snapshot: undefined })], TEST_CONTEXT);
    const enable = disabled.find((item) => item.action?.kind === "enable");
    assert.ok(enable !== undefined);
    assert.equal(enable.label, "Monitoring disabled");

    const signedOut = testStatus({ state: ConnectionState.AuthRequired, snapshot: undefined, message: "sign in" });
    const retry = pickerItems([signedOut], TEST_CONTEXT).find((item) => item.action?.kind === "retry");
    assert.ok(retry !== undefined);
    assert.equal(retry.label, "Usage unavailable");
    assert.equal(retry.description, "sign-in required");
    assert.equal(retry.detail, "sign in");
});

test("limit rows cannot be opened", () =>
{
    const items = pickerItems([testStatus()], TEST_CONTEXT, { provider: "codex", poolId: "codex" });
    const rows = items.filter((item) => item.id.startsWith("window."));
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.action === undefined));
    assert.deepEqual(rows.map((row) => row.label), ["5-hour limit · 3% used", "Weekly limit · 16% used"]);
    assert.ok(rows.every((row) => row.detail?.startsWith("Resets in ")));
});

test("one Antigravity focus includes Gemini and Other pools", () =>
{
    const currentStatuses = statuses();
    const items = pickerItems(currentStatuses, TEST_CONTEXT, { provider: "antigravity" });
    const rows = items.filter((item) => item.id.startsWith("window."));
    assert.equal(rows.length, 3);
    assert.ok(rows.some((item) => item.id.startsWith("window.antigravity.gemini.")));
    assert.ok(rows.some((item) => item.id.startsWith("window.antigravity.other.")));
    assert.equal(pickerTitle(currentStatuses, { provider: "antigravity" }), "Devin Better ACP · Antigravity");
});

test("focused provider pools retain the shared labels and reset layout", () =>
{
    const currentStatuses = statuses();
    const codex = pickerItems(currentStatuses, TEST_CONTEXT, { provider: "codex", poolId: "codex" });
    const gemini = pickerItems(currentStatuses, TEST_CONTEXT, { provider: "antigravity", poolId: "gemini" });
    const rows = (items: PickItem[]) => items.filter((item) => item.id.startsWith("window.")).map((item) =>
    {
        return { label: item.label, description: item.description, detail: item.detail };
    });
    assert.deepEqual(rows(codex), rows(gemini));
    assert.deepEqual(rows(gemini).map((row) => row.label), ["5-hour limit · 3% used", "Weekly limit · 16% used"]);
    for (const items of [codex, gemini])
        assert.deepEqual(items.filter((item) => item.kind === "separator").map((item) => item.label), [
            "Allowance", "Details", "Actions",
        ]);
    assert.equal(gemini.some((item) => item.id === "metadata.codex.Plan"), false);
    assert.equal(pickerTitle(currentStatuses), "Devin Better ACP");
    assert.equal(pickerTitle(currentStatuses, { provider: "codex", poolId: "codex" }), "Devin Better ACP · Codex");
    assert.equal(pickerTitle(currentStatuses, { provider: "antigravity", poolId: "gemini" }),
        "Devin Better ACP · Antigravity · Gemini");
});

test("the overview groups pools without duplicating provider headings", () =>
{
    const items = pickerItems(statuses(), TEST_CONTEXT);
    assert.deepEqual(items.filter((item) => item.kind === "separator").map((item) => item.label), [
        "Codex",
        "Codex · Details",
        "Antigravity · Gemini",
        "Antigravity · Other Models",
        "Antigravity · Details",
        "Actions",
    ]);
    assert.equal(items.filter((item) => item.id.startsWith("window.")).length, 5);
});

test("a focused missing pool stays empty instead of displaying its sibling", () =>
{
    const current = testAntigravityStatus();
    if (current.snapshot === undefined)
        throw new Error("Missing Antigravity fixture snapshot");
    current.snapshot.pools = current.snapshot.pools.filter((pool) => pool.id === "gemini");
    const items = pickerItems([current], TEST_CONTEXT, { provider: "antigravity", poolId: "other" });
    assert.equal(items.some((item) => item.id.startsWith("window.")), false);
    assert.equal(items.find((item) => item.id === "status.antigravity")?.label, "Usage unavailable");
});

test("stale limits stay explicit without changing reported values", () =>
{
    const current = testStatus({ state: ConnectionState.Stale, message: "Offline" });
    const items = pickerItems([current], TEST_CONTEXT, { provider: "codex", poolId: "codex" });
    assert.ok(items.some((item) => item.label === "$(warning) Last known usage" && item.detail === "Offline"));
    assert.equal(items.find((item) => item.id.startsWith("window."))?.label, "5-hour limit · 3% used");
});

test("unknown windows and missing reset times remain readable", () =>
{
    const current = testStatus({
        snapshot: {
            observedAt: TEST_NOW,
            pools: [testPool("codex", "Codex", [testWindow("custom", "Burst", 0)])],
            metadata: [],
        },
    });
    const row = pickerItems([current], TEST_CONTEXT).find((item) => item.id.startsWith("window."));
    assert.equal(row?.label, "Burst limit · 0% used");
    assert.equal(row?.description, undefined);
    assert.equal(row?.detail, "Reset time unknown");
});

test("provider metadata cannot render native icons in the picker", () =>
{
    const current = testStatus({
        snapshot: {
            observedAt: TEST_NOW,
            pools: [testPool("codex", "Codex", [testWindow("custom", "$(zap)\nBurst", 0)])],
            metadata: [{ label: "Plan", value: "$(warning) Plus" }],
        },
    });
    const items = pickerItems([current], TEST_CONTEXT);
    assert.equal(items.find((item) => item.id === "metadata.codex.Plan")?.description, "$ (warning) Plus");
    assert.equal(items.find((item) => item.id.startsWith("window."))?.label, "$ (zap) Burst limit · 0% used");
});

test("a status click keeps its provider and pool scope across refreshes", () =>
{
    const picker = new UsagePicker(callbacks());
    const state = testUsageState(statuses());
    picker.show(state, { provider: "antigravity", poolId: "gemini" });
    const view = current();
    const rows = windowRows(view);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((item) => item.id.startsWith("window.antigravity.gemini.")));
    assert.equal(view.title, "Devin Better ACP · Antigravity · Gemini");
    view.value = "weekly";
    view.activeItems = [rows[1]!];
    picker.update({ ...state, now: 2000 });
    assert.equal(view.value, "weekly");
    assert.equal(view.activeItems[0]?.id, rows[1]?.id);
    assert.equal(windowRows(view).length, 2);
    picker.dispose();
});

test("an Antigravity status click opens one picker with both pools", () =>
{
    const picker = new UsagePicker(callbacks());
    picker.show(testUsageState(statuses()), { provider: "antigravity" });
    const view = current();
    const rows = windowRows(view);
    assert.equal(view.title, "Devin Better ACP · Antigravity");
    assert.equal(rows.length, 3);
    assert.ok(rows.some((item) => item.id.startsWith("window.antigravity.gemini.")));
    assert.ok(rows.some((item) => item.id.startsWith("window.antigravity.other.")));
    picker.dispose();
});

test("limit rows are listed but cannot be opened", () =>
{
    const picker = new UsagePicker(callbacks());
    picker.show(testUsageState(statuses()), { provider: "codex", poolId: "codex" });
    const view = current();
    const row = windowItem(view);
    assert.equal(row.action, undefined);
    assert.equal(row.label, "5-hour limit · 3% used");
    assert.equal(windowRows(view).length, 2);
    const pageBefore = view.title;
    view.accept(row);
    assert.equal(view.title, pageBefore);
    assert.equal(view.disposed, false);
    picker.dispose();
});

test("the refresh button refreshes only the selected provider and shows busy state", async () =>
{
    const actions = callbacks();
    let allCalls = 0;
    const providerCalls: ProviderId[] = [];
    let finish: () => void = () => undefined;
    actions.refreshAll = async () =>
    {
        allCalls += 1;
    };
    actions.refreshProvider = (provider) =>
    {
        providerCalls.push(provider);
        return new Promise<void>((resolve) =>
        {
            finish = resolve;
        });
    };
    const picker = new UsagePicker(actions);
    picker.show(testUsageState(statuses()), { provider: "antigravity" });
    const view = current();
    const refresh = view.buttons.find((button) => button !== BACK);
    assert.ok(refresh !== undefined);
    view.press(refresh);
    assert.equal(allCalls, 0);
    assert.deepEqual(providerCalls, ["antigravity"]);
    assert.equal(view.busy, true);
    view.press(refresh);
    assert.equal(providerCalls.length, 1);
    finish();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(view.busy, false);
    picker.dispose();
});

test("settings and connection actions live in a separate menu with back navigation", () =>
{
    const picker = new UsagePicker(callbacks());
    picker.show(testUsageState(statuses()), { provider: "antigravity" });
    const view = current();
    const settings = view.items.find((item) => item.id === "action.manage");
    assert.ok(settings !== undefined);
    assert.equal(view.items.some((item) => item.action?.kind === "configureCli"), false);
    view.accept(settings);
    assert.ok(view.items.some((item) => item.action?.kind === "configureCli"));
    assert.equal(view.items.some((item) => item.action?.kind === "openChatGptUsage"), false);
    view.press(BACK);
    assert.equal(view.title, "Devin Better ACP · Antigravity");
    picker.dispose();
});

test("back from a focused provider shows the all-provider overview", () =>
{
    const picker = new UsagePicker(callbacks());
    picker.show(testUsageState(statuses()), { provider: "codex" });
    const view = current();
    view.press(BACK);
    assert.equal(view.title, "Devin Better ACP");
    assert.equal(windowRows(view).length, 5);
    picker.dispose();
});
