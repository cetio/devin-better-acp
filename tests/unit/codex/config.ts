import assert from "node:assert/strict";
import { test } from "node:test";

import { readCodexConfig } from "../../../source/codex/config";
import type { ConfigurationReader } from "../../../source/config";
import { codexCLI } from "../../../source/codex/cli";

function reader(values: Record<string, unknown> = {}): ConfigurationReader
{
    return {
        get: (key: string) => values[key],
        inspect: () => undefined,
    } as unknown as ConfigurationReader;
}

test("Codex config owns its extension settings and references the Codex CLI", () =>
{
    const config = readCodexConfig(reader());
    assert.equal(config.id, "codex");
    assert.equal(config.label, "Codex");
    assert.equal(config.enabled, true);
    assert.equal(config.path, "");
    assert.equal(config.visible, true);
    assert.equal(config.cli, codexCLI);

    const changed = readCodexConfig(reader({
        "codex.enabled": false,
        "codex.path": " /opt/codex ",
        "statusBar.showCodex": false,
    }));
    assert.equal(changed.enabled, false);
    assert.equal(changed.path, "/opt/codex");
    assert.equal(changed.visible, false);
});
