import {readFile,writeFile} from 'node:fs/promises';

const palettes=JSON.parse(await readFile('design/brand/tokens.json','utf8'));
function luminance(hex){const a=[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4);return .2126*a[0]+.7152*a[1]+.0722*a[2];}
function contrast(a,b){const x=[luminance(a),luminance(b)].sort((a,b)=>a-b);return (x[1]+.05)/(x[0]+.05);}
const pairs=[
  ...['bg','surface','raised'].flatMap(bg=>[['text',bg,4.5],['muted',bg,4.5],['success',bg,4.5],['warning',bg,4.5],['errorText',bg,4.5],['border',bg,3],['progress',bg,3],['focus',bg,3]]),
  ['onAction','action',4.5],['mark','bg',3],['mark','surface',3],['text','successSurface',4.5],['border','successSurface',3],
  ['onReward','rewardFill',4.5],['ink','rewardFill',4.5],['nightCursor','nightPaper',4.5],['ink','paper',7],['correct','paper',7],
  ['error','paper',3],['error','ink',3],['cursor','paper',3],['cursor','ink',3],
  ['nightInk','nightPaper',7],['cursor','nightPaper',3],['cursor','nightInk',3],['nightError','nightPaper',3],['nightError','nightInk',3]
];
let report='# Folio contrast audit\n\nWCAG relative luminance. Text requires 4.5:1; score ink 7:1; non-text boundaries, indicators, cursor and error-versus-ink require 3:1. Values below are unrounded for pass/fail. The saturated action has an explicit high-contrast border against surrounding surfaces. The wrong-note fill is a deliberate reviewer-approved exception to AAA score-ink contrast: as a non-text graphic it must be at least 3:1 against both the ink and paper. Its AAA-contrast ink outline, ring, × and explanatory text carry the meaning together; colour is never the sole signal. Correct-note green is also checked against ink below; it is not 3:1, so the ink-coloured ✓ is required. The Night cursor uses an opaque 4.5:1-or-higher outline; its translucent fill is a secondary cue, with notes drawn above it. The dim paper makes simultaneous 7:1 paper contrast and 3:1 ink separation unattainable with this ink/paper range.\n\n';
for(const [mode,p] of Object.entries(palettes)){
  report+=`## ${mode}\n\n| Role | Against | Ratio | Minimum |\n| --- | --- | ---: | ---: |\n`;
  for(const [fg,bg,min] of pairs){const value=contrast(p[fg],p[bg]);if(value<min)throw new Error(`${mode}: ${fg}/${bg} = ${value.toFixed(3)} < ${min}`);report+=`| ${fg} ${p[fg]} | ${bg} ${p[bg]} | ${value.toFixed(2)}:1 | ${min}:1 |\n`;}
  const correctInk=contrast(p.correct,p.ink);
  const nightCorrectInk=contrast(p.nightCorrect,p.nightInk);
  report+=`| correct ${p.correct} | ink ${p.ink} | ${correctInk.toFixed(2)}:1 | informational · ✓ required |\n`;
  report+=`| nightCorrect ${p.nightCorrect} | nightInk ${p.nightInk} | ${nightCorrectInk.toFixed(2)}:1 | informational · ✓ required |\n\n`;
}
await writeFile('design/brand/contrast.md',report.trimEnd()+'\n');console.log('Folio text, score, border, status, cursor and error checks pass.');
