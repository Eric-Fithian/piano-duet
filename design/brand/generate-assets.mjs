import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {copyFile,mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

const sharp=createRequire(resolve('site/package.json'))('sharp');
const output='design/brand/assets';
const palette=JSON.parse(await readFile('design/brand/tokens.json','utf8'));
const master=await readFile('design/brand/master/two-voice.svg','utf8');
const hinted=await readFile('design/brand/master/two-voice-16.svg','utf8');
const wordMasters={72:await readFile('design/brand/master/wordmark-display.svg','utf8'),48:await readFile('design/brand/master/wordmark-header.svg','utf8')};
const outlines=JSON.parse(execFileSync('uv',['run','--frozen','--with','uharfbuzz==0.57.0','--with','brotli==1.2.1','python','design/brand/outline-wordmark.py'],{encoding:'utf8'}));
const colors={light:{mark:palette.light.mark,ink:palette.light.text},dark:{mark:palette.dark.mark,ink:palette.dark.text},mono:{mark:'currentColor',ink:'currentColor'}};
const shape=svg=>svg.slice(svg.indexOf('<g '),svg.lastIndexOf('</svg>'));
const wrap=(w,h,inner,title)=>`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${title}">${inner}</svg>`;
const mark=(color,svg=master)=>shape(svg).replaceAll('currentColor',color);
const file=async(name,data)=>writeFile(`${output}/${name}`,data);
const glyphWord=(data,word,x,y,size,color)=>{
  const scale=size/data.upem;
  const paths=data.words[word].paths.map(p=>`<path d="${p.d}" transform="translate(${p.x} ${p.y})"/>`).join('');
  return `<g fill="${color}" transform="translate(${x} ${y}) scale(${scale} ${-scale})">${paths}</g>`;
};
const wordmark=(theme,optical,withMark)=>{
  const source=wordMasters[optical],tag=source.slice(0,source.indexOf('>'));
  const width=Number(tag.split('viewBox="')[1].split('"')[0].split(' ')[2]);
  const words=source.slice(source.indexOf('>')+1,source.lastIndexOf('</svg>'))
    .replace('id="piano" fill="currentColor"',`id="piano" fill="${colors[theme].ink}"`)
    .replace('id="duet" fill="currentColor"',`id="duet" fill="${colors[theme].mark}"`);
  const start=withMark?112:0;
  return wrap(start+width,100,`${withMark?mark(colors[theme].mark):''}<g transform="translate(${start} 0)">${words}</g>`,'Piano Duet');
};
const icon=(size,{scale=0.88,bg=palette.light.bg,color=colors.light.mark,transparent=false}={})=>{
  const offset=(100-100*scale)/2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">${transparent?'':`<rect width="100" height="100" fill="${bg}"/>`}<g transform="translate(${offset} ${offset}) scale(${scale})">${mark(color)}</g></svg>`;
};
async function raster(name,svg,size,opaque=false){let image=sharp(Buffer.from(svg)).resize(size,size);if(opaque)image=image.removeAlpha();await image.png().toFile(`${output}/${name}`);}
await mkdir(output,{recursive:true});
await file('mark.svg',master.replaceAll('currentColor',colors.light.mark));
await file('mark-dark.svg',master.replaceAll('currentColor',colors.dark.mark));
await file('mark-mono.svg',master);
await file('mark-16.svg',hinted.replaceAll('currentColor',colors.light.mark));
await file('mark-16-dark.svg',hinted.replaceAll('currentColor',colors.dark.mark));
await file('mark-16-mono.svg',hinted);
for(const theme of Object.keys(colors)){
  await file(`wordmark-horizontal-${theme}.svg`,wordmark(theme,72,true));
  await file(`wordmark-text-${theme}.svg`,wordmark(theme,72,false));
  await file(`wordmark-horizontal-header-${theme}.svg`,wordmark(theme,48,true));
}
const favicon=hinted.replace('<g fill="currentColor">',`<style>svg{color:${colors.light.mark}}@media(prefers-color-scheme:dark){svg{color:${colors.dark.mark}}}</style><g fill="currentColor">`);
await file('favicon.svg',favicon);
const icoImages=[];
for(const size of [16,32,48]){
  const svg=size===16?hinted.replaceAll('currentColor',colors.light.mark):icon(size,{scale:1,transparent:true});
  icoImages.push(await sharp(Buffer.from(svg)).resize(size,size).png().toBuffer());
}
const header=Buffer.alloc(6+16*icoImages.length);header.writeUInt16LE(1,2);header.writeUInt16LE(icoImages.length,4);let offset=header.length;
for(const [i,data] of icoImages.entries()){const size=[16,32,48][i],at=6+16*i;header[at]=size;header[at+1]=size;header.writeUInt16LE(1,at+4);header.writeUInt16LE(32,at+6);header.writeUInt32LE(data.length,at+8);header.writeUInt32LE(offset,at+12);offset+=data.length;}
await file('favicon.ico',Buffer.concat([header,...icoImages]));
await raster('apple-touch-icon.png',icon(180,{scale:.8}),180,true);
for(const size of [192,512]){
  await raster(`icon-${size}.png`,icon(size),size,true);
  await raster(`icon-maskable-${size}.png`,icon(size,{scale:.69}),size,true);
}
await raster('icon-monochrome-512.png',icon(512,{scale:.69,color:'#000000',transparent:true}),512);
await raster('app-store-1024.png',icon(1024,{scale:.8}),1024,true);
const score=Array.from({length:5},(_,i)=>`<path d="M0 ${i*20}h460" stroke="${palette.light.ink}" stroke-width="2"/>`).join('')+
  [90,155,220,285,350].map((x,i)=>`<ellipse cx="${x}" cy="${[80,70,60,50,40][i]}" rx="12" ry="8.5" transform="rotate(-20 ${x} ${[80,70,60,50,40][i]})" fill="${palette.light.ink}"/><path d="M${x+11} ${[80,70,60,50,40][i]}v-42" stroke="${palette.light.ink}" stroke-width="3"/>`).join('')+
  `<path d="M0 0v80M460 0v80M245 0v80" stroke="${palette.light.ink}" stroke-width="2"/>`;
const display=wordmark('light',72,true);
const displayInner=display.slice(display.indexOf('>',display.indexOf('<svg'))+1,display.lastIndexOf('</svg>'));
const share=(w,h)=>`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 1200 630" preserveAspectRatio="none"><rect width="1200" height="630" fill="${palette.light.bg}"/><g transform="translate(76 70) scale(1.35)">${displayInner}</g>${glyphWord(outlines.atkinson,'Real music. Fresh every time.',82,286,43,palette.light.text)}${glyphWord(outlines.atkinson,'Practice at your piano · Private on your device · Free and open',82,345,26,palette.light.muted)}<g transform="translate(660 420)">${score}</g></svg>`;
for(const [name,w,h] of [['og-image.png',1200,630],['github-social-1280x640.png',1280,640]])await sharp(Buffer.from(share(w,h))).resize(w,h,{fit:'fill'}).removeAlpha().png().toFile(`${output}/${name}`);
const published=['favicon.svg','favicon.ico','apple-touch-icon.png','icon-192.png','icon-512.png','icon-maskable-192.png','icon-maskable-512.png','icon-monochrome-512.png','og-image.png'];
for(const destination of ['src/piano_duet/static/brand','site/public/brand']){
  await mkdir(destination,{recursive:true});
  for(const name of published)await copyFile(`${output}/${name}`,`${destination}/${name}`);
  await copyFile('design/brand/manifest.webmanifest',`${destination}/manifest.webmanifest`);
}
for(const [source,destination] of [['favicon.svg','site/public/favicon.svg'],['favicon.ico','site/public/favicon.ico'],['apple-touch-icon.png','site/public/apple-touch-icon.png'],['og-image.png','site/public/og.png'],['mark.svg','site/src/assets/logo.svg'],['mark-dark.svg','site/src/assets/logo-dark.svg']])await copyFile(`${output}/${source}`,destination);
const declarations=mode=>Object.entries(palette[mode]).map(([key,value])=>`  --brand-${key}: ${value};`).join('\n');
await writeFile('site/src/styles/brand-tokens.css',`:root {\n${declarations('dark')}\n}\n\n:root[data-theme='light'] {\n${declarations('light')}\n}\n`);
console.log(`Generated brand assets in ${output}.`);
