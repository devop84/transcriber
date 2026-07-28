export interface RuntimePaths {
  userData: string;
  downloads: string;
  resourcesPath?: string;
  appPath?: string;
  cwd?: string;
}

let runtimePaths: RuntimePaths | null = null;

export function setRuntimePaths(p: RuntimePaths): void {
  runtimePaths = p;
}

export function getRuntimePaths(): RuntimePaths {
  if (!runtimePaths) {
    throw new Error(
      'Runtime paths not initialized. Call setRuntimePaths() before using @transcriber/core.',
    );
  }
  return runtimePaths;
}
