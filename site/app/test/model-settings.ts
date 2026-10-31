import { setupModelSettings } from "../src/model-settings";
import { ModelStore } from "../src/model-store";
import { acquireModelLock } from "../src/model-lock";
import type { InferenceBackend, ModelFile } from "../src/inference";

const file: ModelFile = { model: "aria", name: "fixture.bin", revision: "fixture-revision",
  url: `${location.origin}/fixture/fixture-revision/fixture.bin`, bytes: 21,
  sha256: "a21e5c2f98f6b674aeeba3d88362cf618da2d78ae6f9a07ff9cac7f2907e283f" };
const store = new ModelStore();
let testFailure = false;
let copiedDiagnostics = "";
Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { copiedDiagnostics = text; } } });
const root = document.querySelector<HTMLDetailsElement>("#modelSettings");
if (!root) throw new Error("Missing test settings");
setupModelSettings(root, {} as InferenceBackend, { store,
  entries: [{ id: "aria", name: "Fixture", use: "Test", credit: "Test", files: [file], used: true }],
  test: async (_id, _backend, currentStore, signal, progress) => {
    if (testFailure) throw new Error("Blob loading failed");
    const text = await (await currentStore.get(file, progress, signal)).text();
    if (text !== "fixture model weights") throw new Error("Fixture output differs from the reference");
    return { passed: true, text: "Passed · fixture" };
  },
});
Object.assign(window, { acquireFixtureLock: () => acquireModelLock("aria"), failFixtureTest: () => { testFailure = true; },
  copiedFixtureDiagnostics: () => copiedDiagnostics });
root.open = false;
root.open = true;
