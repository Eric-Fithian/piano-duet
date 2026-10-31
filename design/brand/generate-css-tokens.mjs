import {readFile, writeFile} from 'node:fs/promises';

const palettes = JSON.parse(await readFile('design/brand/tokens.json', 'utf8'));
const declarations = palette => Object.entries(palette).map(([name, value]) => `  --folio-${name}: ${value};`).join('\n');
const css = `/* Generated from design/brand/tokens.json by generate-css-tokens.mjs. */\n:root, [data-theme=light] {\n${declarations(palettes.light)}\n}\n[data-theme=dark] {\n${declarations(palettes.dark)}\n}\n[data-night=true] {\n  --folio-paper: var(--folio-nightPaper);\n  --folio-ink: var(--folio-nightInk);\n  --folio-correct: var(--folio-nightCorrect);\n  --folio-error: var(--folio-nightError);\n  --folio-cursor: var(--folio-nightCursor);\n}\n`;
const path = 'src/piano_duet/static/tokens.css';
if (process.argv.includes('--check')) {
  if (await readFile(path, 'utf8') !== css) throw new Error(`${path} is out of date`);
} else {
  await writeFile(path, css);
}
