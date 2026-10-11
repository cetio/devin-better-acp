import assert from "node:assert/strict";
import { test } from "node:test";

import {
    bindingWindow,
    compareWindows,
    escapeMarkdown,
    formatAge,
    formatCountdown,
    formatPercent,
    formatResetMoment,
    sanitizeLabel,
    snapshotIsStale,
} from "../../../source/ui/format";
import { ConnectionState, UsagePool, UsageWindow } from "../../../source/usage";
import { TEST_CONTEXT, TEST_NOW, testPool, testStatus, testWindow } from "../../support";

function window(id: string, usedPercent: number, durationMinutes?: number): UsageWindow
{
    return { id, label: id, usedPercent, durationMinutes, resetsAt: undefined };
}

function pool(windows: UsageWindow[]): UsagePool
{
    return { id: "pool", label: "Pool", windows };
}

test("percent formatting preserves small, full, and over-limit values", () =>
{
    assert.equal(formatPercent(0), "0%");
    assert.equal(formatPercent(0.04), "<0.1%");
    assert.equal(formatPercent(0.62), "0.6%");
    assert.equal(formatPercent(3), "3%");
    assert.equal(formatPercent(16), "16%");
    assert.equal(formatPercent(99.96), ">99.9%");
    assert.equal(formatPercent(100), "100%");
    assert.equal(formatPercent(103.4), "103%");
    assert.throws(() => formatPercent(-1), RangeError);
    assert.throws(() => formatPercent(Number.NaN), RangeError);
    assert.throws(() => formatPercent(Number.POSITIVE_INFINITY), RangeError);
});

test("window comparison and binding selection share deterministic tie-breaking", () =>
{
    assert.ok(compareWindows(window("5h", 1, 300), window("week", 1, 10080)) < 0);
    assert.equal(bindingWindow(pool([window("5h", 3), window("W", 16)]))?.id, "W");
    assert.equal(bindingWindow(pool([window("W", 16, 10080), window("5h", 16, 300)]))?.id, "5h");
    assert.equal(bindingWindow(pool([window("b", 5), window("a", 5)]))?.id, "a");
    assert.equal(bindingWindow(pool([])), undefined);
});

test("countdowns stay compact and honest at the boundary", () =>
{
    assert.equal(formatCountdown(0), "now");
    assert.equal(formatCountdown(-5000), "now");
    assert.equal(formatCountdown(30000), "<1m");
    assert.equal(formatCountdown(4 * 3600000 + 10 * 60000), "4h 10m");
    assert.equal(formatCountdown(3 * 86400000 + 4 * 3600000), "3d 4h");
});

test("reset moments retain locale-aware dates and times", () =>
{
    const date = new Date(2030, 4, 9, 8, 7);
    const moment = formatResetMoment(date.getTime());
    assert.match(moment, /^[A-Za-z]{3,} 9, /);
    assert.match(moment, /\d{1,2}:\d{2}/);
});

test("age formatting stays readable across magnitudes", () =>
{
    assert.equal(formatAge(5000), "just now");
    assert.equal(formatAge(30000), "30s ago");
    assert.equal(formatAge(90000), "1m ago");
    assert.equal(formatAge(3 * 3600000), "3h ago");
    assert.equal(formatAge(2 * 86400000), "2d ago");
    assert.equal(formatAge(Number.NaN), "unknown");
});

test("provider labels are stripped of controls and bounded", () =>
{
    assert.equal(sanitizeLabel("  Gemini \n Models \t"), "Gemini Models");
    const sanitized = sanitizeLabel("x".repeat(80));
    assert.equal(sanitized.length, 48);
    assert.ok(sanitized.endsWith("\u2026"));
});

test("provider markdown text is escaped", () =>
{
    assert.equal(escapeMarkdown("a|b"), "a\\|b");
    assert.equal(escapeMarkdown("`code`"), "\\`code\\`");
    assert.equal(escapeMarkdown("$(zap)"), "\\$\\(zap\\)");
    assert.equal(escapeMarkdown("**bold**"), "\\*\\*bold\\*\\*");
    assert.equal(escapeMarkdown("<tag>"), "\\<tag\\>");
});

test("snapshot staleness depends only on state and the last successful read", () =>
{
    const current = testStatus({
        snapshot: {
            pools: [testPool("codex", "Codex", [testWindow("primary", "5h", 12, 300)])],
            metadata: [],
        },
    });
    assert.equal(snapshotIsStale({ ...current, lastSuccessAt: undefined }, TEST_NOW, 600000), false);
    assert.equal(snapshotIsStale(current, TEST_NOW, Number.POSITIVE_INFINITY), false);
    assert.equal(snapshotIsStale(current, TEST_NOW + 600001, 600000), true);
    assert.equal(snapshotIsStale({ ...current, state: ConnectionState.Stale }, TEST_NOW, 600000), true);
    assert.equal(snapshotIsStale({ ...current, snapshot: undefined }, TEST_NOW, 1), false);
    assert.equal(TEST_CONTEXT.now, TEST_NOW);
});
