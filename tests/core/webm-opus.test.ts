import assert from "node:assert/strict";
import test from "node:test";
import { webmOpusPadding } from "../../src/core/webm-opus.ts";

const element = (id: number[], content: number[]) => {
  if (content.length >= 127) throw new Error("The test element is too large");
  return [...id, 0x80 | content.length, ...content];
};
const track = element([0xae], [...element([0xd7], [1]), ...element([0x56, 0xaa], [0x63, 0x2e, 0xa0])]);
const tracks = element([0x16, 0x54, 0xae, 0x6b], track);
const block = element([0xa3], [0x81, 0, 0, 0]);
const last = element([0xa0], [...element([0xa1], [0x81, 0, 0, 0]), ...element([0x75, 0xa2], [0, 0xcd, 0xfe, 0x60])]);
const other = element([0xa3], [0x82, 0, 0, 0]);
const file = (children: number[]) => Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x80, 0x18, 0x53, 0x80, 0x67, 0xff, ...tracks, ...children]).buffer;

test("WebM extracts Opus delay and the final block's discard padding", () => {
  const cluster = element([0x1f, 0x43, 0xb6, 0x75], [...block, ...last, ...other]);
  assert.deepEqual(webmOpusPadding(file(cluster), 1), { codecDelayNs: 6500000, startPaddingNs: 0, endPaddingNs: 13500000 });
});

test("WebM rejects padding in the middle of an audio track and truncated elements", () => {
  const cluster = element([0x1f, 0x43, 0xb6, 0x75], [...block, ...last, ...block]);
  assert.throws(() => webmOpusPadding(file(cluster), 1), { message: "WebM has unsupported audio padding within the track" });
  const truncated = file(cluster).slice(0, -1);
  assert.throws(() => webmOpusPadding(truncated, 1), { message: "The WebM container has a truncated element" });
});
