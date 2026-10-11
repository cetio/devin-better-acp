import { asRecord, asString } from "../envelope";
import { runCli } from "../process/runner";

import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, copyFile, mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const MAX_ENTRY_BYTES = 1024 * 1024;
const ENTRY_TIMEOUT_MS = 10000;

export type AntigravityInstallPaths = {
    installDirectory: string;
    shimPath: string;
    serverPath: string;
    registryPath: string;
};

export type AntigravityInstallResult = {
    installDirectory: string;
    registryPath: string;
};

export function antigravityInstallPaths(
    environment: NodeJS.ProcessEnv = process.env,
    homeDirectory: string = homedir(),
): AntigravityInstallPaths
{
    const home = resolve(homeDirectory);
    const installDirectory = resolve(
        environment.DEVIN_BETTER_ACP_INSTALL_DIR || join(home, ".local", "lib", "devin-better-acp"),
    );
    return {
        installDirectory,
        shimPath: join(installDirectory, "source", "antigravity", "acp.py"),
        serverPath: resolve(
            environment.AGY_ACP_SERVER_PATH || join(home, ".local", "opt", "agy-acp", "current", "agy_acp_server.par"),
        ),
        registryPath: resolve(environment.DEVIN_ACP_REGISTRY_PATH || join(home, ".windsurf", "acp", "registry.json")),
    };
}

export function registryWithEntry(registryValue: unknown, entryValue: unknown, shimPath: string): string
{
    const registry = asRecord(registryValue);
    if (registry === undefined || !Array.isArray(registry.agents))
        throw new Error("Invalid ACP registry structure.");
    const entry = asRecord(entryValue);
    const entryId = asString(entry?.id);
    if (entry === undefined || entryId === undefined)
        throw new Error("Generated ACP registry entry has no agent ID.");
    const retEntry = JSON.parse(JSON.stringify(entry)) as Record<string, unknown>;
    const distribution = asRecord(retEntry.distribution);
    const launches = asRecord(distribution?.binary);
    if (launches === undefined)
        throw new Error("Generated ACP registry entry has no binary launch configuration.");
    for (const launchValue of Object.values(launches))
    {
        const launch = asRecord(launchValue);
        const argumentsList = launch?.args;
        if (!Array.isArray(argumentsList) || argumentsList.length === 0 || typeof argumentsList[0] !== "string")
            throw new Error("Generated ACP registry entry has no shim launch path.");
        argumentsList[0] = shimPath;
    }

    const replaceIds = new Set([entryId, "antigravity-devin"]);
    const agents = registry.agents;
    const insertAt = agents.findIndex((agentValue) =>
    {
        const agent = asRecord(agentValue);
        const id = asString(agent?.id);
        return id !== undefined && replaceIds.has(id);
    });
    const retained = agents.filter((agentValue) =>
    {
        const agent = asRecord(agentValue);
        const id = asString(agent?.id);
        return id === undefined || !replaceIds.has(id);
    });
    retained.splice(Math.min(insertAt < 0 ? retained.length : insertAt, retained.length), 0, retEntry);
    return `${JSON.stringify({ ...registry, agents: retained }, null, 2)}\n`;
}

export async function installAntigravity(
    extensionPath: string,
    environment: NodeJS.ProcessEnv = process.env,
    homeDirectory: string = homedir(),
): Promise<AntigravityInstallResult>
{
    const extensionRoot = resolve(extensionPath);
    const paths = antigravityInstallPaths(environment, homeDirectory);
    const sourceRoot = join(extensionRoot, "source");
    const sourceShim = join(sourceRoot, "antigravity", "acp.py");
    const sourceIntegration = join(sourceRoot, "mcp", "server.py");
    await requireFile(sourceShim, "Antigravity ACP shim");
    await requireFile(sourceIntegration, "Antigravity integration server");
    await requireFile(paths.serverPath, "Antigravity ACP server");

    const python = environment.PYTHON || "python3";
    const generated = await runCli({
        command: python,
        args: [
            sourceShim,
            "--registry-entry",
            "--server",
            paths.serverPath,
            "--spoof-zed",
            "--devin-config",
            "--system-prompt",
            "--",
            "--uid=",
        ],
        cwd: extensionRoot,
        timeoutMs: ENTRY_TIMEOUT_MS,
        maxStdoutBytes: MAX_ENTRY_BYTES,
    });
    if (generated.exit.spawnError !== undefined)
        throw new Error(`Python executable was not found: ${python}`);
    if (generated.exit.timedOut)
        throw new Error("Generating the ACP registry entry timed out.");
    if (generated.exit.outputLimitExceeded || generated.exit.code !== 0)
        throw new Error("Could not generate the ACP registry entry.");

    let generatedEntry: unknown;
    try
    {
        generatedEntry = JSON.parse(generated.stdout);
    }
    catch
    {
        throw new Error("Antigravity returned an invalid ACP registry entry.");
    }
    const registry = await readRegistry(paths.registryPath);
    const registryText = registryWithEntry(registry, generatedEntry, paths.shimPath);

    await installModules(sourceRoot, paths.installDirectory);
    await writeRegistry(paths.registryPath, registryText);
    return { installDirectory: paths.installDirectory, registryPath: paths.registryPath };
}

async function installModules(sourceRoot: string, installDirectory: string): Promise<void>
{
    const installedRoot = join(installDirectory, "source");
    await mkdir(installedRoot, { recursive: true });
    await copyModule(join(sourceRoot, "__init__.py"), join(installedRoot, "__init__.py"), 0o644);
    const obsoletePresentation = join(installedRoot, "antigravity", "presentation.py");
    await unlink(obsoletePresentation).catch((error: unknown) =>
    {
        if (!isMissingFile(error))
            throw error;
    });
    for (const domain of ["antigravity", "mcp"])
        await copyModules(join(sourceRoot, domain), join(installedRoot, domain));
}

async function copyModules(sourceDirectory: string, targetDirectory: string): Promise<void>
{
    await mkdir(targetDirectory, { recursive: true });
    for (const entry of await readdir(sourceDirectory, { withFileTypes: true }))
    {
        const sourcePath = join(sourceDirectory, entry.name);
        const targetPath = join(targetDirectory, entry.name);
        if (entry.isDirectory())
            await copyModules(sourcePath, targetPath);
        else if (entry.isFile() && entry.name.endsWith(".py"))
        {
            const mode = entry.name === "acp.py" || entry.name === "server.py" ? 0o755 : 0o644;
            await copyModule(sourcePath, targetPath, mode);
        }
    }
}

async function copyModule(sourcePath: string, targetPath: string, mode: number): Promise<void>
{
    const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
    try
    {
        await copyFile(sourcePath, temporaryPath, fsConstants.COPYFILE_EXCL);
        await chmod(temporaryPath, mode);
        await rename(temporaryPath, targetPath);
    }
    catch (error)
    {
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
    }
}

async function readRegistry(registryPath: string): Promise<Record<string, unknown>>
{
    let text: string;
    try
    {
        text = await readFile(registryPath, "utf8");
    }
    catch (error)
    {
        if (isMissingFile(error))
            return { version: "1.0.0", agents: [] };
        throw new Error(`Could not read ACP registry: ${registryPath}`);
    }

    let parsed: unknown;
    try
    {
        parsed = JSON.parse(text);
    }
    catch
    {
        throw new Error("The ACP registry contains invalid JSON.");
    }
    const registry = asRecord(parsed);
    if (registry === undefined || !Array.isArray(registry.agents))
        throw new Error("Invalid ACP registry structure.");
    return registry;
}

async function writeRegistry(registryPath: string, text: string): Promise<void>
{
    const directory = dirname(registryPath);
    await mkdir(directory, { recursive: true });
    let mode = 0o644;
    try
    {
        mode = (await stat(registryPath)).mode & 0o777;
    }
    catch (error)
    {
        if (!isMissingFile(error))
            throw error;
    }

    const temporaryPath = `${registryPath}.${randomUUID()}.tmp`;
    const file = await open(temporaryPath, "wx", 0o600);
    let committed = false;
    try
    {
        await file.writeFile(text, "utf8");
        await file.chmod(mode);
        await file.sync();
        await file.close();
        await rename(temporaryPath, registryPath);
        committed = true;
    }
    finally
    {
        await file.close().catch(() => undefined);
        if (!committed)
            await unlink(temporaryPath).catch(() => undefined);
    }
}

async function requireFile(path: string, label: string): Promise<void>
{
    let attributes;
    try
    {
        attributes = await stat(path);
    }
    catch
    {
        throw new Error(`${label} not found: ${path}`);
    }
    if (!attributes.isFile())
        throw new Error(`${label} not found: ${path}`);
}

function isMissingFile(error: unknown): boolean
{
    if (typeof error !== "object" || error === null || !("code" in error))
        return false;
    return (error as NodeJS.ErrnoException).code === "ENOENT";
}
