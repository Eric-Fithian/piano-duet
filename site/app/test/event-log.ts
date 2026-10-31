import { EventLog } from "../src/event-log";

Object.assign(window, { createEventLog: () => new EventLog() });
