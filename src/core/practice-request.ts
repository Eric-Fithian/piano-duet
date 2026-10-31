import type { PracticeNote } from "./practice-assessment.ts";

export type ValidationIssue = { loc: (string | number)[]; msg: string; type: string };
export type PracticeRequest = { focus: string; piece: string | null; step_by_step: boolean; after: string | null; stage: number | null };

type Result<T> = { value: T; errors: ValidationIssue[] };
type Location = (string | number)[];

export function parseJsonBody(body: BodyInit | null | undefined): Result<unknown> {
  if (typeof body !== "string" || !body.length) return { value: null, errors: [{ loc: ["body"], msg: "A JSON body is required", type: "missing" }] };
  try { return { value: JSON.parse(body), errors: [] }; }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { value: null, errors: [{ loc: ["body"], msg: "Invalid JSON", type: "json_invalid" }] };
  }
}

function issue(errors: ValidationIssue[], loc: Location, msg: string, type = "value_error"): void {
  errors.push({ loc, msg, type });
}

function object(input: unknown, errors: ValidationIssue[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    issue(errors, ["body"], "Expected a JSON object", "model_attributes_type");
    return {};
  }
  return input as Record<string, unknown>;
}

function required(data: Record<string, unknown>, field: string, errors: ValidationIssue[]): boolean {
  if (Object.hasOwn(data, field)) return true;
  issue(errors, ["body", field], "Field required", "missing");
  return false;
}

function booleanValue(input: unknown, loc: Location, errors: ValidationIssue[]): boolean {
  if (typeof input === "boolean") return input;
  if (input === 0 || input === 1) return input === 1;
  if (typeof input === "string") {
    const value = input.toLowerCase();
    if (["1", "true", "on", "yes", "y", "t"].includes(value)) return true;
    if (["0", "false", "off", "no", "n", "f"].includes(value)) return false;
  }
  issue(errors, loc, "Expected a boolean", "bool_parsing");
  return false;
}

function uuidValue(input: unknown, loc: Location, errors: ValidationIssue[]): string | null {
  if (typeof input !== "string") { issue(errors, loc, "Expected a UUID", "uuid_type"); return null; }
  const raw = input.toLowerCase().replaceAll("-", "");
  const lengths = input.split("-").map((part) => part.length).join(",");
  if (raw.length !== 32 || [...raw].some((character) => !"0123456789abcdef".includes(character))
      || (input.includes("-") && lengths !== "8,4,4,4,12")) {
    issue(errors, loc, "Expected a UUID", "uuid_parsing"); return null;
  }
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
}

function numeric(input: unknown, loc: Location, errors: ValidationIssue[], min: number, max: number, integer: boolean, exclusiveMin = false): number {
  const value = typeof input === "number" ? input : typeof input === "boolean" ? Number(input)
    : typeof input === "string" && input.trim() ? Number(input) : NaN;
  if (!Number.isFinite(value) || (integer && !Number.isInteger(value))) {
    issue(errors, loc, integer ? "Expected an integer" : "Expected a number", integer ? "int_parsing" : "float_parsing");
  } else if (exclusiveMin ? value <= min : value < min) issue(errors, loc, `Must be ${exclusiveMin ? "greater than" : "at least"} ${min}`, "greater_than_equal");
  else if (value > max) issue(errors, loc, `Must be at most ${max}`, "less_than_equal");
  return value;
}

export function validatePracticeRequest(input: unknown, stageCount: number): Result<PracticeRequest> {
  const errors: ValidationIssue[] = [], data = object(input, errors);
  if (errors.length) return { value: { focus: "guided", piece: null, step_by_step: false, after: null, stage: null }, errors };
  const focus = Object.hasOwn(data, "focus") ? data.focus : "guided";
  if (typeof focus !== "string" || !["guided", "technique", "reading", "theory", "ear", "repertoire"].includes(focus)) {
    issue(errors, ["body", "focus"], "Choose a valid practice focus", "literal_error");
  }
  const piece = data.piece == null ? null : uuidValue(data.piece, ["body", "piece"], errors);
  const step_by_step = Object.hasOwn(data, "step_by_step") ? booleanValue(data.step_by_step, ["body", "step_by_step"], errors) : false;
  const after = data.after == null ? null : uuidValue(data.after, ["body", "after"], errors);
  const stage = data.stage == null ? null : numeric(data.stage, ["body", "stage"], errors, 1, stageCount, true);
  return { value: { focus: typeof focus === "string" ? focus : "guided", piece, step_by_step, after, stage }, errors };
}

export function validateAid(input: unknown): Result<"reveals" | "hearings" | "hints"> {
  const errors: ValidationIssue[] = [], data = object(input, errors), value = data.kind;
  if (errors.length) return { value: "hints", errors };
  if (required(data, "kind", errors) && (typeof value !== "string" || !["reveals", "hearings", "hints"].includes(value))) {
    issue(errors, ["body", "kind"], "Choose a valid kind of help", "literal_error");
  }
  return { value: value as "reveals" | "hearings" | "hints", errors };
}

export function validatePiece(input: unknown): Result<{ attempt: string; title: string }> {
  const errors: ValidationIssue[] = [], data = object(input, errors);
  if (errors.length) return { value: { attempt: "", title: "" }, errors };
  const attempt = required(data, "attempt", errors) ? uuidValue(data.attempt, ["body", "attempt"], errors) : null;
  const title = data.title;
  if (required(data, "title", errors)) {
    if (typeof title !== "string") issue(errors, ["body", "title"], "Expected a title", "string_type");
    else if (!title.length || [...title].length > 80) issue(errors, ["body", "title"], "Title must contain 1–80 characters", "string_length");
  }
  return { value: { attempt: attempt ?? "", title: typeof title === "string" ? title : "" }, errors };
}

export function validateExclusion(input: unknown): Result<boolean> {
  const errors: ValidationIssue[] = [], data = object(input, errors);
  if (errors.length) return { value: false, errors };
  const value = required(data, "excluded", errors) ? booleanValue(data.excluded, ["body", "excluded"], errors) : false;
  return { value, errors };
}

export function validateMidi(input: unknown): Result<PracticeNote[]> {
  const errors: ValidationIssue[] = [], data = object(input, errors);
  if (errors.length) return { value: [], errors };
  if (!required(data, "notes", errors)) return { value: [], errors };
  if (!Array.isArray(data.notes)) { issue(errors, ["body", "notes"], "Expected a list of notes", "list_type"); return { value: [], errors }; }
  if (!data.notes.length) issue(errors, ["body", "notes"], "At least one note is required", "too_short");
  const notes = data.notes.map((item, index) => {
    const loc: Location = ["body", "notes", index];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      issue(errors, loc, "Expected a note", "model_attributes_type"); return { pitch: 0, start: 0, duration: 0, velocity: 0 };
    }
    const note = item as Record<string, unknown>;
    const field = (name: string, min: number, max: number, integer: boolean, exclusive = false) => {
      if (!Object.hasOwn(note, name)) { issue(errors, [...loc, name], "Field required", "missing"); return 0; }
      return numeric(note[name], [...loc, name], errors, min, max, integer, exclusive);
    };
    return { pitch: field("pitch", 21, 108, true), start: field("start", 0, Infinity, false),
      duration: field("duration", 0, Infinity, false, true), velocity: field("velocity", 1, 127, true) };
  });
  return { value: notes, errors };
}

export function validatePathUuid(value: string, field: string): Result<string | null> {
  const errors: ValidationIssue[] = [];
  return { value: uuidValue(value, ["path", field], errors), errors };
}

export function validatePracticeQuery(params: URLSearchParams): Result<{ session: string; task: string | null; attempt: string; source: string; threshold: number }> {
  const errors: ValidationIssue[] = [];
  const session = params.has("session") ? uuidValue(params.get("session"), ["query", "session"], errors) : null;
  if (!params.has("session")) issue(errors, ["query", "session"], "Field required", "missing");
  const task = params.has("task") ? uuidValue(params.get("task"), ["query", "task"], errors) : null;
  const attempt = params.has("attempt") ? uuidValue(params.get("attempt"), ["query", "attempt"], errors) : crypto.randomUUID();
  const source = params.get("source") ?? "microphone";
  if (!["microphone", "demo"].includes(source)) issue(errors, ["query", "source"], "Choose microphone or demo", "literal_error");
  const threshold = params.has("threshold") ? numeric(params.get("threshold"), ["query", "threshold"], errors, 0.1, 0.99, false) : 0.8;
  for (const [field, min, max, integer] of [["seconds", 2, 12, false], ["temperature", 0.5, 1.3, false],
    ["difficulty", 1, 5, true], ["surprise", 0, 1, false]] as const) {
    if (params.has(field)) numeric(params.get(field), ["query", field], errors, min, max, integer);
  }
  if (params.has("lesson")) uuidValue(params.get("lesson"), ["query", "lesson"], errors);
  if (params.has("stage") && !["idea", "repeat"].includes(params.get("stage")!)) issue(errors, ["query", "stage"], "Choose idea or repeat", "literal_error");
  if ((params.get("listening")?.length ?? 0) > 20000) issue(errors, ["query", "listening"], "Listening summary is too long", "string_too_long");
  return { value: { session: session ?? "", task, attempt: attempt ?? "", source, threshold }, errors };
}
