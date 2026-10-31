import { SampleStore } from "../src/sample-store";
Object.assign(window, { createSampleStore: (...args: ConstructorParameters<typeof SampleStore>) => new SampleStore(...args) });
