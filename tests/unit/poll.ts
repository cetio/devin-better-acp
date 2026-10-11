import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

import { startPolling } from "../../source/poll";

test("zero and invalid polling intervals do not create timers", () =>
{
    assert.equal(startPolling(() => undefined, 0), undefined);
    assert.equal(startPolling(() => undefined, Number.NaN), undefined);
});

test("a positive polling interval runs until stopped", async () =>
{
    let calls = 0;
    const stop = startPolling(() => calls += 1, 5);
    assert.ok(stop !== undefined);
    await delay(25);
    stop();
    assert.ok(calls > 0);
});
