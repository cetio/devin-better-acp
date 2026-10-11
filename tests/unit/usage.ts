import assert from "node:assert/strict";
import { test } from "node:test";

import { AdapterError, AdapterResult, ProviderAdapter, ProviderSetup } from "../../source/adapter";
import { ConnectionState } from "../../source/allowance/model";
import { TimerHandle, UsageService } from "../../source/usage";
import { Version } from "../../source/process/version";

class FakeTimers
{
    private nextId = 1;
    private readonly handles = new Map<number, { dueAt: number; callback: () => void }>();
    readonly delays: number[] = [];
    now = 0;

    setTimeout = (callback: () => void, delayMs: number): TimerHandle =>
    {
        const id = this.nextId++;
        this.delays.push(delayMs);
        this.handles.set(id, { dueAt: this.now + delayMs, callback });
        return {
            cancel: () =>
            {
                this.handles.delete(id);
            },
        };
    };

    get pending(): number
    {
        return this.handles.size;
    }

    async fireDue(): Promise<void>
    {
        const due = [...this.handles.entries()].sort((left, right) => left[1].dueAt - right[1].dueAt)[0];
        if (due === undefined)
            return;
        this.handles.delete(due[0]);
        this.now = due[1].dueAt;
        due[1].callback();
        await flush();
    }
}

type AdapterHarness = {
    adapter: ProviderAdapter;
    calls: { read: number; version: number };
};

function makeAdapter(overrides: {
    read?: () => Promise<AdapterResult>;
    version?: () => Promise<string>;
    minimumVersion?: Version;
    command?: string;
} = {}): AdapterHarness
{
    const calls = { read: 0, version: 0 };
    const adapter: ProviderAdapter = {
        id: "codex",
        label: "Codex",
        command: overrides.command ?? "/usr/bin/codex",
        readArgs: ["app-server", "--stdio"],
        minimumVersion: overrides.minimumVersion,
        version: async () =>
        {
            calls.version += 1;
            return overrides.version === undefined ? "0.160.0" : overrides.version();
        },
        read: async () =>
        {
            calls.read += 1;
            return overrides.read === undefined ? sampleResult() : overrides.read();
        },
    };
    return { adapter, calls };
}

function sampleResult(usedPercent = 16, resetsAt?: number): AdapterResult
{
    return {
        observedAt: 0,
        pools: [{
            id: "codex",
            label: "Codex",
            description: undefined,
            windows: [{ id: "codex:primary", label: "5h", usedPercent, durationMinutes: 300, resetsAt }],
        }],
        metadata: [],
    };
}

function setup(adapter: ProviderAdapter | undefined, enabled = true): ProviderSetup
{
    const message = adapter === undefined ? "CLI missing" : undefined;
    return { provider: "codex", label: "Codex", enabled, adapter, message };
}

function makeUsage(
    timers: FakeTimers,
    options: { intervalMs?: number; staleAfterMs?: number; onRefresh?: () => void } = {},
): UsageService
{
    return new UsageService({
        intervalMs: options.intervalMs ?? 300000,
        staleAfterMs: options.staleAfterMs ?? 600000,
        now: () => timers.now,
        random: () => 0,
        setTimeout: timers.setTimeout,
        onDidChange: () => undefined,
        onRefresh: () => options.onRefresh?.(),
    });
}

async function flush(): Promise<void>
{
    for (let i = 0; i < 5; i++)
        await new Promise((resolve) => setImmediate(resolve));
}

test("a successful refresh records a ready snapshot and schedules the next poll", async () =>
{
    const timers = new FakeTimers();
    const { adapter, calls } = makeAdapter();
    const usage = makeUsage(timers);
    usage.configure([setup(adapter)]);
    await flush();

    const status = usage.getStatuses()[0];
    assert.ok(status !== undefined);
    assert.equal(status.state, ConnectionState.Ready);
    assert.equal(status.cliVersion, "0.160.0");
    assert.equal(status.snapshot?.pools[0]?.windows[0]?.usedPercent, 16);
    assert.equal(calls.version, 1);
    assert.equal(calls.read, 1);
    assert.deepEqual(timers.delays, [60000, 300000]);
    usage.dispose();
});

test("the unified state owns the clock and staleness threshold", async () =>
{
    const timers = new FakeTimers();
    const { adapter } = makeAdapter();
    const usage = makeUsage(timers, { intervalMs: 0, staleAfterMs: 30000 });
    usage.configure([setup(adapter)]);
    await flush();

    const initial = usage.getState();
    assert.equal(initial.now, 0);
    assert.equal(initial.staleAfterMs, 30000);
    assert.deepEqual(timers.delays, [60000]);

    await timers.fireDue();
    const state = usage.getState();
    const status = state.statuses[0];
    assert.equal(state.now, 60000);
    assert.ok(status?.lastSuccessAt !== undefined);
    assert.ok(state.now - status.lastSuccessAt > state.staleAfterMs);
    usage.dispose();
});

test("concurrent refreshes share a single in-flight request", async () =>
{
    const timers = new FakeTimers();
    const { adapter, calls } = makeAdapter();
    const usage = makeUsage(timers);
    usage.configure([setup(adapter)]);
    await Promise.all([usage.refresh("codex"), usage.refresh("codex", { manual: true })]);
    await flush();

    assert.equal(calls.read, 1);
    usage.dispose();
});

test("a transient failure keeps last-known values and backs off", async () =>
{
    const timers = new FakeTimers();
    let fail = false;
    const { adapter, calls } = makeAdapter({
        read: async () =>
        {
            if (fail)
                throw new AdapterError(ConnectionState.Unavailable, "offline");
            return sampleResult();
        },
    });
    const usage = makeUsage(timers);
    usage.configure([setup(adapter)]);
    await flush();
    assert.equal(usage.getStatuses()[0]?.state, ConnectionState.Ready);

    fail = true;
    timers.delays.length = 0;
    await usage.refresh("codex");
    const status = usage.getStatuses()[0];
    assert.equal(status?.state, ConnectionState.Stale);
    assert.equal(status?.message, "offline");
    assert.equal(status?.snapshot?.pools[0]?.windows[0]?.usedPercent, 16);
    assert.deepEqual(timers.delays, [600000]);
    assert.equal(calls.read, 2);
    usage.dispose();
});

test("an authentication failure clears cached values and stops auto polling", async () =>
{
    const timers = new FakeTimers();
    let fail = false;
    const { adapter } = makeAdapter({
        read: async () =>
        {
            if (fail)
                throw new AdapterError(ConnectionState.AuthRequired, "sign in");
            return sampleResult();
        },
    });
    const usage = makeUsage(timers);
    usage.configure([setup(adapter)]);
    await flush();

    fail = true;
    timers.delays.length = 0;
    await usage.refresh("codex");
    const status = usage.getStatuses()[0];
    assert.equal(status?.state, ConnectionState.AuthRequired);
    assert.equal(status?.snapshot, undefined);
    assert.deepEqual(timers.delays, []);
    usage.dispose();
});

test("the version gate blocks automatic polling until an explicit retry", async () =>
{
    const timers = new FakeTimers();
    const { adapter, calls } = makeAdapter({
        minimumVersion: { major: 1, minor: 2, patch: 16 },
        version: async () => "1.2.15",
    });
    const usage = makeUsage(timers);
    usage.configure([setup(adapter)]);
    await flush();

    const blocked = usage.getStatuses()[0];
    assert.equal(blocked?.state, ConnectionState.Unsupported);
    assert.equal(blocked?.cliVersion, "1.2.15");
    assert.equal(calls.read, 0);
    assert.deepEqual(timers.delays, []);

    await usage.refresh("codex", { manual: true });
    await flush();
    assert.equal(calls.read, 1);
    assert.equal(usage.getStatuses()[0]?.state, ConnectionState.Ready);
    usage.dispose();
});

test("pausing cancels work, clears values, and resumes on request", async () =>
{
    const timers = new FakeTimers();
    const { adapter, calls } = makeAdapter();
    const usage = makeUsage(timers);
    usage.configure([setup(adapter)]);
    await flush();
    assert.equal(calls.read, 1);

    usage.setPaused("Trust this workspace to enable usage monitoring.");
    const paused = usage.getStatuses()[0];
    assert.equal(paused?.state, ConnectionState.Unavailable);
    assert.equal(paused?.message, "Trust this workspace to enable usage monitoring.");
    assert.equal(paused?.snapshot, undefined);
    assert.equal(timers.pending, 0);

    await usage.refresh("codex", { manual: true });
    assert.equal(calls.read, 1);

    usage.setPaused(undefined);
    await flush();
    assert.equal(calls.read, 2);
    assert.equal(usage.getStatuses()[0]?.state, ConnectionState.Ready);
    usage.dispose();
});

test("changing the CLI path resets provider state", async () =>
{
    const timers = new FakeTimers();
    const first = makeAdapter({ command: "/usr/bin/codex" });
    const second = makeAdapter({ command: "/opt/other/codex" });
    const usage = makeUsage(timers);
    usage.configure([setup(first.adapter)]);
    await flush();
    assert.equal(usage.getStatuses()[0]?.snapshot !== undefined, true);

    usage.configure([setup(second.adapter)]);
    assert.equal(usage.getStatuses()[0]?.snapshot, undefined);
    await flush();
    assert.equal(second.calls.read, 1);
    assert.equal(first.calls.read, 1);
    usage.dispose();
});

test("a reset boundary schedules one prompt refresh", async () =>
{
    const timers = new FakeTimers();
    const { adapter, calls } = makeAdapter({ read: async () => sampleResult(50, 1000) });
    const usage = makeUsage(timers);
    usage.configure([setup(adapter)]);
    await flush();

    assert.deepEqual(timers.delays, [60000, 6000]);
    await timers.fireDue();
    assert.equal(calls.read, 2);
    usage.dispose();
});

test("unfocused windows stop polling and resume when overdue", async () =>
{
    const timers = new FakeTimers();
    const { adapter, calls } = makeAdapter();
    const usage = makeUsage(timers);
    usage.configure([setup(adapter)]);
    await flush();

    usage.setFocused(false);
    assert.equal(timers.pending, 1);

    timers.now += 300000;
    usage.setFocused(true);
    await flush();
    assert.equal(calls.read, 2);
    usage.dispose();
});

test("disabled and missing providers do not spawn work", async () =>
{
    const timers = new FakeTimers();
    const { adapter, calls } = makeAdapter();
    const usage = makeUsage(timers);
    usage.configure([setup(undefined)]);
    usage.configure([setup(adapter, false)]);
    await flush();

    assert.equal(calls.read, 0);
    assert.equal(timers.pending, 0);
    usage.dispose();
});

test("dispose stops timers and further refreshes", async () =>
{
    const timers = new FakeTimers();
    const { adapter, calls } = makeAdapter();
    const usage = makeUsage(timers);
    usage.configure([setup(adapter)]);
    await flush();

    usage.dispose();
    assert.equal(timers.pending, 0);
    await usage.refresh("codex", { manual: true });
    assert.equal(calls.read, 1);
});
