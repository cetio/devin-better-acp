import assert from "node:assert/strict";
import { test } from "node:test";

import { asNumber, asRecord, asString, parseDurationMinutes } from "../../source/parse";

test("shared parsers reject invalid object and scalar shapes", () =>
{
    assert.deepEqual(asRecord({ value: 1 }), { value: 1 });
    assert.equal(asRecord(null), undefined);
    assert.equal(asRecord([]), undefined);
    assert.equal(asString("  Codex  "), "Codex");
    assert.equal(asString("  "), undefined);
    assert.equal(asNumber(1), 1);
    assert.equal(asNumber(Number.NaN), undefined);
});

test("usage duration parsing accepts known windows and bounded positive values", () =>
{
    assert.equal(parseDurationMinutes("weekly"), 10080);
    assert.equal(parseDurationMinutes(" daily "), 1440);
    assert.equal(parseDurationMinutes("monthly"), 43200);
    assert.equal(parseDurationMinutes("5h"), 300);
    assert.equal(parseDurationMinutes("90m"), 90);
    assert.equal(parseDurationMinutes("0d"), undefined);
    assert.equal(parseDurationMinutes("unknown"), undefined);
});
