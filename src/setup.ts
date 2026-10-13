import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { OrcodeError } from "./errors.ts";
import { runProcess } from "./process.ts";

export interface SetupResult {
  host: "codex" | "claude" | "muse";
  action: "installed" | "already-configured" | "removed" | "not-configured";
  detail: string;
}

type MuseSettings = Record<string, unknown> & {
  mcpServers?: Record<string, Record<string, unknown>>;
};

export function museSettingsPath(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.ORCODE_MUSE_SETTINGS && isAbsolute(environment.ORCODE_MUSE_SETTINGS)) {
    return environment.ORCODE_MUSE_SETTINGS;
  }
  const configHome =
    environment.XDG_CONFIG_HOME && isAbsolute(environment.XDG_CONFIG_HOME)
      ? environment.XDG_CONFIG_HOME
      : join(homedir(), ".config");
  return join(configHome, "muse", "settings.json");
}

function readMuseSettings(): MuseSettings | undefined {
  const path = museSettingsPath();
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as MuseSettings;
  } catch {
    throw new OrcodeError(
      "SETUP_CONFLICT",
      `Muse settings at ${path} are not valid JSON; fix them before running setup.`,
    );
  }
}

function writeMuseSettings(settings: MuseSettings): void {
  const path = museSettingsPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
}

function museConfiguration(): Record<string, unknown> | undefined {
  return readMuseSettings()?.mcpServers?.orcode;
}

function isOrcodeMuseEntry(entry: Record<string, unknown> | undefined): boolean {
  if (!entry) return false;
  const text = JSON.stringify(entry);
  return text.includes("orcode") && text.includes("muse");
}

function commandName(): string {
  return process.env.ORCODE_COMMAND ?? "orcode";
}

async function codexConfiguration(): Promise<unknown | undefined> {
  const codex = process.env.ORCODE_CODEX_BIN ?? "codex";
  const result = await runProcess(codex, ["mcp", "get", "orcode", "--json"], {
    timeoutMs: 5_000,
  });
  if (result.exitCode !== 0) return undefined;
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    return result.stdout;
  }
}

async function claudeConfiguration(): Promise<string | undefined> {
  const claude = process.env.ORCODE_CLAUDE_BIN ?? "claude";
  const result = await runProcess(claude, ["mcp", "get", "orcode"], { timeoutMs: 5_000 });
  return result.exitCode === 0 ? result.stdout : undefined;
}

function isOrcodeConfiguration(value: unknown, host: "codex" | "claude"): boolean {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.includes("orcode") && text.includes("mcp") && text.includes(host);
}

async function removeCodex(): Promise<void> {
  const codex = process.env.ORCODE_CODEX_BIN ?? "codex";
  const result = await runProcess(codex, ["mcp", "remove", "orcode"]);
  if (result.exitCode !== 0) {
    throw new OrcodeError(
      "PROVIDER_UNAVAILABLE",
      result.stderr.trim() || "Could not remove the Codex MCP configuration.",
    );
  }
}

async function removeClaude(): Promise<void> {
  const claude = process.env.ORCODE_CLAUDE_BIN ?? "claude";
  const result = await runProcess(claude, ["mcp", "remove", "--scope", "user", "orcode"]);
  if (result.exitCode !== 0) {
    throw new OrcodeError(
      "PROVIDER_UNAVAILABLE",
      result.stderr.trim() || "Could not remove the Claude MCP configuration.",
    );
  }
}

export async function setup(force = false): Promise<SetupResult[]> {
  const results: SetupResult[] = [];
  const command = commandName();
  const [codexConfig, claudeConfig] = await Promise.all([
    codexConfiguration(),
    claudeConfiguration(),
  ]);
  if (
    codexConfig !== undefined &&
    !isOrcodeConfiguration(codexConfig, "codex") &&
    !force
  ) {
    throw new OrcodeError(
      "SETUP_CONFLICT",
      "Codex already has an MCP server named orcode that Orcode does not own. Re-run with --force to replace it.",
    );
  }
  if (
    claudeConfig !== undefined &&
    !isOrcodeConfiguration(claudeConfig, "claude") &&
    !force
  ) {
    throw new OrcodeError(
      "SETUP_CONFLICT",
      "Claude already has an MCP server named orcode that Orcode does not own. Re-run with --force to replace it.",
    );
  }
  const existingMuseEntry = museConfiguration();
  if (existingMuseEntry !== undefined && !isOrcodeMuseEntry(existingMuseEntry) && !force) {
    throw new OrcodeError(
      "SETUP_CONFLICT",
      "Muse already has an MCP server named orcode that Orcode does not own. Re-run with --force to replace it.",
    );
  }

  if (codexConfig !== undefined) {
    if (isOrcodeConfiguration(codexConfig, "codex") && !force) {
      results.push({ host: "codex", action: "already-configured", detail: "user MCP entry" });
    } else {
      await removeCodex();
    }
  }
  if (!results.some((result) => result.host === "codex")) {
    const codex = process.env.ORCODE_CODEX_BIN ?? "codex";
    const result = await runProcess(codex, [
      "mcp",
      "add",
      "orcode",
      "--",
      command,
      "mcp",
      "--host",
      "codex",
    ]);
    if (result.exitCode !== 0) {
      throw new OrcodeError(
        "PROVIDER_UNAVAILABLE",
        result.stderr.trim() || "Could not configure Orcode in Codex.",
      );
    }
    results.push({ host: "codex", action: "installed", detail: "user MCP entry" });
  }
  if (claudeConfig !== undefined) {
    if (isOrcodeConfiguration(claudeConfig, "claude") && !force) {
      results.push({ host: "claude", action: "already-configured", detail: "user MCP entry" });
    } else {
      await removeClaude();
    }
  }
  if (!results.some((result) => result.host === "claude")) {
    const claude = process.env.ORCODE_CLAUDE_BIN ?? "claude";
    const result = await runProcess(claude, [
      "mcp",
      "add",
      "--scope",
      "user",
      "orcode",
      "--",
      command,
      "mcp",
      "--host",
      "claude",
    ]);
    if (result.exitCode !== 0) {
      throw new OrcodeError(
        "PROVIDER_UNAVAILABLE",
        result.stderr.trim() || "Could not configure Orcode in Claude.",
      );
    }
    results.push({ host: "claude", action: "installed", detail: "user MCP entry" });
  }

  const museEntry = museConfiguration();
  if (museEntry !== undefined && !isOrcodeMuseEntry(museEntry) && !force) {
    throw new OrcodeError(
      "SETUP_CONFLICT",
      "Muse already has an MCP server named orcode that Orcode does not own. Re-run with --force to replace it.",
    );
  }
  if (museEntry !== undefined && isOrcodeMuseEntry(museEntry) && !force) {
    results.push({ host: "muse", action: "already-configured", detail: "user MCP entry" });
  } else {
    const settings = readMuseSettings() ?? { schema_version: 1 };
    settings.mcpServers = {
      ...settings.mcpServers,
      orcode: {
        type: "stdio",
        command,
        args: ["mcp", "--host", "muse"],
        mode: "optional",
      },
    };
    writeMuseSettings(settings);
    results.push({ host: "muse", action: "installed", detail: "user MCP entry" });
  }
  return results;
}

export async function uninstall(): Promise<SetupResult[]> {
  const results: SetupResult[] = [];
  const codexConfig = await codexConfiguration();
  if (codexConfig === undefined) {
    results.push({ host: "codex", action: "not-configured", detail: "no MCP entry" });
  } else if (!isOrcodeConfiguration(codexConfig, "codex")) {
    throw new OrcodeError(
      "SETUP_CONFLICT",
      "Refusing to remove the Codex MCP server named orcode because Orcode does not own it.",
    );
  } else {
    await removeCodex();
    results.push({ host: "codex", action: "removed", detail: "user MCP entry" });
  }

  const claudeConfig = await claudeConfiguration();
  if (claudeConfig === undefined) {
    results.push({ host: "claude", action: "not-configured", detail: "no MCP entry" });
  } else if (!isOrcodeConfiguration(claudeConfig, "claude")) {
    throw new OrcodeError(
      "SETUP_CONFLICT",
      "Refusing to remove the Claude MCP server named orcode because Orcode does not own it.",
    );
  } else {
    await removeClaude();
    results.push({ host: "claude", action: "removed", detail: "user MCP entry" });
  }

  const museEntry = museConfiguration();
  if (museEntry === undefined) {
    results.push({ host: "muse", action: "not-configured", detail: "no MCP entry" });
  } else if (!isOrcodeMuseEntry(museEntry)) {
    throw new OrcodeError(
      "SETUP_CONFLICT",
      "Refusing to remove the Muse MCP server named orcode because Orcode does not own it.",
    );
  } else {
    const settings = readMuseSettings() as MuseSettings;
    if (settings.mcpServers) delete settings.mcpServers.orcode;
    writeMuseSettings(settings);
    results.push({ host: "muse", action: "removed", detail: "user MCP entry" });
  }
  return results;
}

export async function configuredHosts(): Promise<{
  codex: boolean;
  claude: boolean;
  muse: boolean;
}> {
  const [codex, claude] = await Promise.all([codexConfiguration(), claudeConfiguration()]);
  return {
    codex: codex !== undefined && isOrcodeConfiguration(codex, "codex"),
    claude: claude !== undefined && isOrcodeConfiguration(claude, "claude"),
    muse: isOrcodeMuseEntry(museConfiguration()),
  };
}
