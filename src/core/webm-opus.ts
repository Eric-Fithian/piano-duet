type Element = { id: number; start: number; end: number; unknown: boolean };

export function webmOpusPadding(data: ArrayBuffer, trackId: number): { codecDelayNs: number | null; startPaddingNs: number; endPaddingNs: number } {
  const bytes = new Uint8Array(data);
  let codecDelayNs: number | null = null, startPaddingNs = 0, endPaddingNs = 0, blocks = 0, endBlock = -1;
  let foundTrack = false;
  const readChildren = (start: number, end: number, visit: (element: Element) => void) => {
    for (let offset = start; offset < end;) {
      const [id, idLength] = variable(bytes, offset, false);
      const [size, sizeLength, unknown] = variable(bytes, offset + idLength, true);
      const body = offset + idLength + sizeLength, limit = unknown ? end : body + size;
      if (limit > end || body > limit) throw new Error("The WebM container has a truncated element");
      visit({ id, start: body, end: limit, unknown });
      offset = limit;
    }
  };
  const trackEntry = (entry: Element) => {
    let number: number | null = null, delay: number | null = null;
    readChildren(entry.start, entry.end, (element) => {
      if (element.id === 0xd7) number = integer(bytes, element.start, element.end, false);
      if (element.id === 0x56aa) delay = integer(bytes, element.start, element.end, false);
    });
    if (number === trackId) { if (foundTrack) throw new Error("WebM defines an audio track more than once"); foundTrack = true; codecDelayNs = delay; }
  };
  const group = (entry: Element) => {
    let track: number | null = null, padding: number | null = null;
    readChildren(entry.start, entry.end, (element) => {
      if (element.id === 0xa1) track = variable(bytes, element.start, true)[0];
      if (element.id === 0x75a2) padding = integer(bytes, element.start, element.end, true);
    });
    if (track !== trackId) return;
    blocks++;
    if (padding !== null && padding < 0) {
      if (blocks !== 1 || startPaddingNs) throw new Error("WebM has unsupported audio padding within the track");
      startPaddingNs = -padding;
    } else if (padding !== null && padding > 0) {
      if (endBlock !== -1) throw new Error("WebM has unsupported audio padding within the track");
      endPaddingNs = padding; endBlock = blocks;
    }
  };
  const cluster = (entry: Element) => readChildren(entry.start, entry.end, (element) => {
    if (element.id === 0xa0) group(element);
    else if (element.id === 0xa3 && variable(bytes, element.start, true)[0] === trackId) blocks++;
    else if (element.id === 0x1f43b675) cluster(element);
  });
  const segment = (entry: Element) => readChildren(entry.start, entry.end, (element) => {
    if (element.id === 0x1654ae6b) readChildren(element.start, element.end, (child) => { if (child.id === 0xae) trackEntry(child); });
    else if (element.id === 0x1f43b675) cluster(element);
  });
  readChildren(0, bytes.length, (element) => { if (element.id === 0x18538067) segment(element); });
  if (!foundTrack || !blocks) throw new Error("The WebM audio track is missing its metadata or audio blocks");
  if (endBlock !== -1 && endBlock !== blocks) throw new Error("WebM has unsupported audio padding within the track");
  return { codecDelayNs, startPaddingNs, endPaddingNs };
}

function variable(bytes: Uint8Array, offset: number, value: boolean): [number, number, boolean] {
  if (offset >= bytes.length || !bytes[offset]) throw new Error("The WebM container has an invalid element header");
  let width = 1, marker = 0x80;
  while (!(bytes[offset] & marker)) { width++; marker >>= 1; }
  if (width > (value ? 8 : 4) || offset + width > bytes.length) throw new Error("The WebM container has a truncated element header");
  let number = BigInt(value ? bytes[offset] & (marker - 1) : bytes[offset]);
  for (let index = 1; index < width; index++) number = number * 256n + BigInt(bytes[offset + index]);
  const unknown = value && number === (1n << BigInt(width * 7)) - 1n;
  if (!unknown && number > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("The WebM element is too large");
  return [unknown ? 0 : Number(number), width, unknown];
}

function integer(bytes: Uint8Array, start: number, end: number, signed: boolean): number {
  if (end <= start || end - start > 8) throw new Error("The WebM container has an invalid integer");
  let result = 0n;
  for (let index = start; index < end; index++) result = result * 256n + BigInt(bytes[index]);
  if (signed && bytes[start] & 0x80) result -= 1n << BigInt((end - start) * 8);
  if (result < BigInt(Number.MIN_SAFE_INTEGER) || result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("The WebM integer is too large");
  return Number(result);
}
