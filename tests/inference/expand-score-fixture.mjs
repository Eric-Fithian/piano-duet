import { mkdir, readFile, writeFile } from "node:fs/promises";

const fixture = JSON.parse(await readFile("tests/fixtures/score-model/synthetic.json", "utf8"));
for (const [name, width] of Object.entries({ onset: 200, duration: 200, pitch: 128, velocity: 8 })) {
  fixture.source[name] = [fixture.source[name][0].map((value) => {
    if (!Number.isInteger(value) || value < 0 || value >= width) throw new Error(`Invalid fixture ${name}`);
    const row = Array(width).fill(0); row[value] = 1; return row;
  })];
}
await mkdir(".cache/m2st", { recursive: true });
await writeFile(".cache/m2st/synthetic-parity.json", JSON.stringify(fixture));
