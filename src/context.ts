import { identifyProject } from "./project.ts";
import type { Provider, SelfContext } from "./types.ts";

function isProvider(value: string | undefined): value is Provider {
  return value === "codex" || value === "claude";
}

export function selfContext(
  requestedProvider?: Provider,
  environment = process.env,
): SelfContext {
  const cwd = environment.ORCODE_CWD ?? process.cwd();
  const project = identifyProject(cwd);
  const provider = isProvider(environment.ORCODE_PROVIDER)
    ? environment.ORCODE_PROVIDER
    : requestedProvider;
  const name = environment.ORCODE_NAME ?? `unmanaged-${process.ppid}`;
  return {
    ...(provider === undefined ? {} : { provider }),
    name,
    address:
      environment.ORCODE_ADDRESS ??
      (provider === undefined ? `session:${name}` : `${provider}:${name}`),
    cwd,
    projectId: environment.ORCODE_PROJECT_ID ?? project.id,
    projectRoot: environment.ORCODE_PROJECT_ROOT ?? project.root,
  };
}

export function contextEnvironment(context: SelfContext): Record<string, string> {
  return {
    ...(context.provider === undefined ? {} : { ORCODE_PROVIDER: context.provider }),
    ORCODE_NAME: context.name,
    ORCODE_ADDRESS: context.address,
    ORCODE_CWD: context.cwd,
    ORCODE_PROJECT_ID: context.projectId,
    ORCODE_PROJECT_ROOT: context.projectRoot,
  };
}
