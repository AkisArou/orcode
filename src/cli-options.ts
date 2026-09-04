import { OrcodeError } from "./errors.ts";
import type { Provider } from "./types.ts";
import type { WrapperOptions } from "./wrappers.ts";

function optionValue(args: string[], option: string): string | undefined {
  const index = args.indexOf(option);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new OrcodeError("INVALID_ARGUMENT", `${option} requires a value.`);
  }
  return value;
}

export function parseWrapperOptions(args: string[]): WrapperOptions {
  const separator = args.indexOf("--");
  const own = separator < 0 ? args : args.slice(0, separator);
  const forwarded = separator < 0 ? [] : args.slice(separator + 1);
  const name = optionValue(own, "--name");
  const resume = optionValue(own, "--resume");
  const recognized = new Set([
    ...(name === undefined ? [] : ["--name", name]),
    ...(resume === undefined ? [] : ["--resume", resume]),
  ]);
  const unknown = own.filter((argument) => !recognized.has(argument));
  if (unknown.length > 0) {
    throw new OrcodeError(
      "INVALID_ARGUMENT",
      `Unknown wrapper option ${unknown[0]}; put provider options after --.`,
    );
  }
  return {
    ...(name === undefined ? {} : { name }),
    ...(resume === undefined ? {} : { resume }),
    forwarded,
  };
}

export function hostOption(args: string[]): Provider {
  const host = optionValue(args, "--host");
  if (host !== "codex" && host !== "claude") {
    throw new OrcodeError("INVALID_ARGUMENT", "--host must be codex or claude.");
  }
  return host;
}
