import { BrowserInference } from "../src/browser-inference";
import { decodeLiveOnsets } from "../src/live-onsets";

Object.assign(window, { createBrowserInference: (...args: ConstructorParameters<typeof BrowserInference>) => new BrowserInference(...args), decodeLiveOnsets });
