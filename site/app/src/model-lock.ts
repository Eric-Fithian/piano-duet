import type { AssetId } from "./inference.ts";

function lockName(model: AssetId): string {
  return `piano-duet-model:${model}`;
}

export async function acquireModelLock(model: AssetId, signal?: AbortSignal): Promise<() => void> {
  if (!navigator.locks) throw new Error("This browser cannot protect model storage while it is in use");
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  return new Promise((resolve, reject) => {
    void navigator.locks.request(lockName(model), { mode: "shared", signal }, async () => {
      resolve(release);
      await held;
    }).catch(reject);
  });
}

export async function withModelWriteLock<T>(model: AssetId, action: () => Promise<T>): Promise<T> {
  if (!navigator.locks) throw new Error("This browser cannot protect model storage while it is in use");
  return navigator.locks.request(lockName(model), { ifAvailable: true }, async (lock) => {
    if (!lock) throw new Error("This model is in use. Close the other session or reload the app before changing its files.");
    return action();
  });
}
