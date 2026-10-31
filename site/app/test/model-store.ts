import { ModelStore } from "../src/model-store";

Object.assign(window, { createModelStore: () => new ModelStore() });
