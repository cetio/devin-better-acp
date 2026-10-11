import assert from "node:assert/strict";
import { test } from "node:test";

import {
    bindingWindow,
    durationAbbreviation,
    durationLabel,
    escapeMarkdown,
    formatAge,
    formatCountdown,
    formatPercent,
    formatResetMoment,
    remainingPercent,
    sanitizeLabel,
    windowAbbreviation,
} from "../../../source/allowance/format";
import { UsagePool, UsageWindow } from "../../../source/allowance/model";

function window(id: string, usedPercent: number, durationMinutes?: number): UsageWindow
{
    return { id, label: id, usedPercent, durationMinutes, resetsAt: undefined };
}

function labeledWindow(id: string, label: string): UsageWindow
{
    return { id, label, usedPercent: 1, durationMinutes: undefined, resetsAt: undefined };
}

function pool(windows: UsageWindow[]): UsagePool
{
    return { id: "pool", label: "Pool", description: undefined, windows };
}

test("percent formatting never claims full or zero usage for small values", () =>
{
    assert.equal(formatPercent(0), "0%");
    assert.equal(formatPercent(0.04), "<0.1%");
    assert.equal(formatPercent(0.62), "0.6%");
    assert.equal(formatPercent(3), "3%");
    assert.equal(formatPercent(16), "16%");
    assert.equal(formatPercent(99.96), ">99.9%");
    assert.equal(formatPercent(100), "100%");
    assert.equal(formatPercent(103.4), "103%");
});

test("percent formatting rejects invalid usage values", () =>
{
    assert.throws(() => formatPercent(-1), RangeError);
    assert.throws(() => formatPercent(Number.NaN), RangeError);
    assert.throws(() => formatPercent(Number.POSITIVE_INFINITY), RangeError);
});

test("remaining percent floors at zero for over-consumed windows", () =>
{
    assert.equal(remainingPercent(16), 84);
    assert.equal(remainingPercent(100), 0);
    assert.equal(remainingPercent(120), 0);
});

test("the binding window is the most used, preferring shorter ties", () =>
{
    assert.equal(bindingWindow(pool([window("5h", 3), window("W", 16)]))?.id, "W");
    assert.equal(bindingWindow(pool([window("W", 16), window("5h", 16)]))?.id, "5h");
    assert.equal(bindingWindow(pool([window("b", 5), window("a", 5)]))?.id, "a");
    assert.equal(bindingWindow(pool([])), undefined);
});

test("window abbreviations prefer durations and known names", () =>
{
    assert.equal(durationAbbreviation(300), "5h");
    assert.equal(durationAbbreviation(10080), "W");
    assert.equal(durationAbbreviation(1440), "1d");
    assert.equal(durationAbbreviation(90), "90m");
    assert.equal(durationLabel(10080), "Weekly");
    assert.equal(durationLabel(1440), "Daily");
    assert.equal(durationLabel(300), "5h");
    assert.equal(windowAbbreviation(window("a", 1, 10080)), "W");
    assert.equal(windowAbbreviation(labeledWindow("b", "weekly")), "W");
    assert.equal(windowAbbreviation(labeledWindow("c", "5h")), "5h");
    assert.equal(windowAbbreviation(labeledWindow("d", "billing cycle")), "bil");
});

test("countdown formatting is compact and honest at the boundary", () =>
{
    assert.equal(formatCountdown(0), "now");
    assert.equal(formatCountdown(-5000), "now");
    assert.equal(formatCountdown(30000), "<1m");
    assert.equal(formatCountdown(4 * 3600000 + 10 * 60000), "4h 10m");
    assert.equal(formatCountdown(3 * 86400000 + 4 * 3600000), "3d 4h");
});

test("reset moments read like the native plan card", () =>
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

test("labels are stripped of control characters and bounded", () =>
{
    assert.equal(sanitizeLabel("  Gemini \n Models \t"), "Gemini Models");
    const long = "x".repeat(80);
    const sanitized = sanitizeLabel(long);
    assert.equal(sanitized.length, 48);
    assert.ok(sanitized.endsWith("\u2026"));
});

test("markdown escaping neutralizes provider text", () =>
{
    assert.equal(escapeMarkdown("a|b"), "a\\|b");
    assert.equal(escapeMarkdown("`code`"), "\\`code\\`");
    assert.equal(escapeMarkdown("$(zap)"), "\\$\\(zap\\)");
    assert.equal(escapeMarkdown("**bold**"), "\\*\\*bold\\*\\*");
    assert.equal(escapeMarkdown("<tag>"), "\\<tag\\>");
});
