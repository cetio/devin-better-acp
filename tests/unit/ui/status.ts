import { ConnectionState } from "../../../source/allowance/model";
import { testAntigravityStatus, testPool, testSnapshot, testStatus, testWindow, TEST_CONTEXT, TEST_NOW } from "../../support";
import type { UsageState } from "../../../source/usage";

import assert from "node:assert/strict";
import { mock, test } from "node:test";

type FakeStatusItem = {
    id: string;
    name: string;
    text: string;
    tooltip: { value: string } | undefined;
    backgroundColor: unknown;
    accessibilityInformation: { label: string } | undefined;
    command: { title: string; command: string; arguments?: unknown[] } | undefined;
    visible: boolean;
    disposed: boolean;
    show: () => void;
    hide: () => void;
    dispose: () => void;
};

class StatusItem implements FakeStatusItem
{
    name = "";
    text = "";
    tooltip: { value: string } | undefined;
    backgroundColor: unknown;
    accessibilityInformation: { label: string } | undefined;
    command: { title: string; command: string; arguments?: unknown[] } | undefined;
    visible = false;
    disposed = false;

    constructor(readonly id: string)
    {
    }

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
        this.disposed = true;
    }
}

const statusItems = new Map<string, StatusItem>();
const host = {
    StatusBarAlignment: { Left: 1, Right: 2 },
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
    window: {
        createStatusBarItem: (id: string) =>
        {
            const ret = new StatusItem(id);
            statusItems.set(id, ret);
            return ret;
        },
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
const statusModule = require("../../../source/ui/status") as typeof import("../../../source/ui/status");
replacement.mock.restore();

const { StatusBarView, statusDisplay } = statusModule;

test("a ready status shows the provider label and binding-window tone", () =>
{
    const display = statusDisplay(testStatus(), "codex", TEST_CONTEXT);
    assert.equal(display.visible, true);
    assert.equal(display.text, "Codex");
    assert.equal(display.tone, "normal");
    assert.ok(display.accessibility.includes("16% used in the Weekly window"));
});

test("loading, unavailable, and disabled statuses stay honest", () =>
{
    const loading = statusDisplay(testStatus({
        state: ConnectionState.Loading,
        snapshot: undefined,
        refreshing: true,
        lastSuccessAt: undefined,
    }), "codex", TEST_CONTEXT);
    assert.equal(loading.text, "Codex");

    const unavailable = statusDisplay(testStatus({
        state: ConnectionState.MissingCli,
        snapshot: undefined,
        refreshing: false,
        message: "The codex CLI was not found.",
    }), "codex", TEST_CONTEXT);
    assert.equal(unavailable.text, "Codex");
    assert.ok(unavailable.tooltip.includes("CLI not found"));

    const disabled = statusDisplay(testStatus({ state: ConnectionState.Disabled }), "codex", TEST_CONTEXT);
    assert.equal(disabled.visible, false);
});

test("stale values stay labelled and keep their tone", () =>
{
    const display = statusDisplay(testStatus({ state: ConnectionState.Stale, message: "offline" }), "codex", TEST_CONTEXT);
    assert.equal(display.text, "Codex");
    assert.equal(display.tone, "normal");
    assert.ok(display.tooltip.includes("Last known values"));
    assert.ok(display.tooltip.includes("offline"));
    assert.ok(display.accessibility.includes("stale"));
});

test("usage tones escalate at the warning and error thresholds", () =>
{
    const warning = statusDisplay(testStatus({ snapshot: testSnapshot(90) }), "codex", TEST_CONTEXT);
    const error = statusDisplay(testStatus({ snapshot: testSnapshot(100) }), "codex", TEST_CONTEXT);
    assert.equal(warning.tone, "warning");
    assert.equal(error.tone, "error");
});

test("Codex hovers summarise every window in one line", () =>
{
    const display = statusDisplay(testStatus(), "codex", TEST_CONTEXT);
    assert.equal(display.tooltip, "5h: 3% quota used · Weekly: 16% quota used");
});

test("stale hovers keep the summary and explain the staleness", () =>
{
    const display = statusDisplay(testStatus({ state: ConnectionState.Stale, message: "offline" }), "codex", TEST_CONTEXT);
    assert.ok(display.tooltip.startsWith("5h: 3% quota used · Weekly: 16% quota used"));
    assert.ok(display.tooltip.includes("Last known values"));
    assert.ok(display.tooltip.includes("offline"));
});

test("one Antigravity item summarizes both pools and uses their highest limit", () =>
{
    const current = testAntigravityStatus();
    const otherPool = current.snapshot?.pools.find((pool) => pool.id === "other");
    assert.ok(otherPool !== undefined);
    const otherWindow = otherPool.windows[0];
    assert.ok(otherWindow !== undefined);
    otherWindow.usedPercent = 96;

    const display = statusDisplay(current, "antigravity", TEST_CONTEXT);
    assert.equal(display.text, "Antigravity");
    assert.equal(display.tone, "warning");
    assert.ok(display.tooltip.includes("**Gemini Models**"));
    assert.ok(display.tooltip.includes("**Claude and GPT models**"));
    assert.ok(display.accessibility.includes("Gemini Models:"));
    assert.ok(display.accessibility.includes("Claude and GPT models:"));
});

test("a missing Antigravity pool does not hide its available sibling", () =>
{
    const current = testAntigravityStatus({ state: ConnectionState.Partial });
    if (current.snapshot === undefined)
        throw new Error("Missing Antigravity fixture snapshot");
    current.snapshot.pools = current.snapshot.pools.filter((pool) => pool.id === "gemini");

    const display = statusDisplay(current, "antigravity", TEST_CONTEXT);
    assert.equal(display.visible, true);
    assert.ok(display.tooltip.includes("**Gemini Models**"));
    assert.equal(display.tooltip.includes("Claude and GPT models"), false);
});

test("provider text is escaped inside hover markdown", () =>
{
    const hostile = testStatus({
        snapshot: {
            observedAt: TEST_NOW,
            pools: [testPool("codex", "Codex", [testWindow("codex:primary", "5h | `x` $(zap)", 12, 300)])],
            metadata: [{ label: "Plan | tier", value: "**plus**" }],
        },
    });
    const display = statusDisplay(hostile, "codex", TEST_CONTEXT);
    assert.equal(display.tooltip, "5h \\| \\`x\\` \\$\\(zap\\): 12% quota used");
});

test("status bar creation uses one stable item per provider", () =>
{
    const view = new StatusBarView("right", { codex: true, antigravity: true });
    const state: UsageState = {
        statuses: [testStatus(), testAntigravityStatus()],
        now: TEST_CONTEXT.now,
        staleAfterMs: TEST_CONTEXT.staleAfterMs,
    };
    view.update(state);

    assert.equal(statusItems.size, 2);
    assert.equal(statusItems.get("devinBetterACP.codex")?.visible, true);
    const antigravity = statusItems.get("devinBetterACP.antigravity");
    assert.equal(antigravity?.visible, true);
    assert.equal(antigravity?.text, "Antigravity");
    assert.deepEqual(antigravity?.command?.arguments, [{ provider: "antigravity" }]);
    assert.equal(statusItems.has("devinBetterACP.gemini"), false);
    assert.equal(statusItems.has("devinBetterACP.other"), false);
    view.dispose();
});
