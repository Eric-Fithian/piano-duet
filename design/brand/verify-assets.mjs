import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {chromium} from 'playwright';

const require=createRequire(resolve('site/package.json'));
const sharp=require('sharp');
const {DOMParser}=require('@xmldom/xmldom');
const dir='design/brand/assets';
const distributed=['favicon.svg','favicon.ico','apple-touch-icon.png','icon-192.png','icon-512.png','icon-maskable-192.png','icon-maskable-512.png','icon-monochrome-512.png','og-image.png','wordmark-horizontal-header-light.svg','wordmark-horizontal-header-dark.svg'];
for(const destination of ['src/piano_duet/static/brand','site/public/brand']){
  for(const name of distributed)assert.deepEqual(await readFile(`${destination}/${name}`),await readFile(`${dir}/${name}`),`${destination}/${name} is stale`);
  assert.deepEqual(await readFile(`${destination}/manifest.webmanifest`),await readFile('design/brand/manifest.webmanifest'),`${destination} manifest is stale`);
}
for(const [source,destination] of [['favicon.svg','site/public/favicon.svg'],['favicon.ico','site/public/favicon.ico'],['apple-touch-icon.png','site/public/apple-touch-icon.png'],['og-image.png','site/public/og.png'],['mark.svg','site/src/assets/logo.svg'],['mark-dark.svg','site/src/assets/logo-dark.svg']])assert.deepEqual(await readFile(destination),await readFile(`${dir}/${source}`),`${destination} is stale`);
const source=await readFile('design/brand/master/two-voice.svg','utf8');
const doc=new DOMParser().parseFromString(source,'image/svg+xml');
const heads=[...Array.from(doc.getElementsByTagName('ellipse'))];
assert.equal(heads.length,2);
assert.deepEqual(heads.map(e=>[e.getAttribute('rx'),e.getAttribute('ry')]),[['12','8.5'],['12','8.5']]);
assert.equal(Math.abs(Number(heads[0].getAttribute('cy'))-Number(heads[1].getAttribute('cy'))),19);
assert.equal(doc.getElementsByTagName('g')[0].getAttribute('transform'),'translate(0 -3)');
assert.equal(doc.getElementsByTagName('path')[0].getAttribute('d'),'M22.5 63h7v28h-7z');
assert.equal(doc.getElementsByTagName('path')[1].getAttribute('d'),'M69.5 14h7v28h-7z');
const textMasters={display:await readFile('design/brand/master/wordmark-display.svg','utf8'),header:await readFile('design/brand/master/wordmark-header.svg','utf8')};
assert.notEqual(textMasters.display,textMasters.header,'Display and header optical masters are identical');
for(const master of Object.values(textMasters))assert.ok(!master.includes('<text')&&master.includes('id="piano"')&&master.includes('id="duet"'));
const masterShape=source.slice(source.indexOf('<g '),source.lastIndexOf('</svg>'));
for(const [theme,color] of [['light','#286b4c'],['dark','#9dd5b0'],['mono','currentColor']]){
  const name=theme==='light'?'mark.svg':`mark-${theme}.svg`;
  const mark=await readFile(`${dir}/${name}`,'utf8');
  const expected=masterShape.replaceAll('currentColor',color);
  assert.ok(mark.includes(expected),`${name} is not from the master`);
  for(const prefix of ['wordmark-horizontal','wordmark-horizontal-header']){
    const wordmark=await readFile(`${dir}/${prefix}-${theme}.svg`,'utf8');
    assert.ok(wordmark.includes(expected),`${prefix}-${theme} has a different mark`);
    assert.ok(!wordmark.includes('<text'),`${prefix}-${theme} is not outlined`);
    const master=prefix.endsWith('header')?textMasters.header:textMasters.display;
    const inner=master.slice(master.indexOf('>')+1,master.lastIndexOf('</svg>')).replace('id="piano" fill="currentColor"',`id="piano" fill="${theme==='light'?'#1c2821':theme==='dark'?'#f7f2e8':'currentColor'}"`).replace('id="duet" fill="currentColor"',`id="duet" fill="${color}"`);
    assert.ok(wordmark.includes(inner),`${prefix}-${theme} is not from its outlined wordmark master`);
  }
  assert.ok(!(await readFile(`${dir}/wordmark-text-${theme}.svg`,'utf8')).includes('<text'));
}
const hinted=await readFile(`${dir}/mark-16.svg`,'utf8');
assert.ok(hinted.includes('viewBox="0 0 16 16"')&&hinted.includes('h2v5')&&hinted.includes('rx="3" ry="2"'));
for(const [name,color] of [['mark-16-dark.svg','#9dd5b0'],['mark-16-mono.svg','currentColor']]){const variant=await readFile(`${dir}/${name}`,'utf8');const master=await readFile('design/brand/master/two-voice-16.svg','utf8');assert.equal(variant,master.replaceAll('currentColor',color),`${name} differs from the hinted master`);}
const favicon=await readFile(`${dir}/favicon.svg`,'utf8');assert.ok(favicon.includes('prefers-color-scheme:dark'));
const hintMaster=await readFile('design/brand/master/two-voice-16.svg','utf8');const hintShape=hintMaster.slice(hintMaster.indexOf('<g '),hintMaster.lastIndexOf('</svg>'));assert.ok(favicon.includes(hintShape),'Favicon does not use the hinted master');
const ico=await readFile(`${dir}/favicon.ico`);assert.equal(ico.readUInt16LE(4),3);assert.deepEqual([ico[6],ico[22],ico[38]],[16,32,48]);
const first=ico.subarray(ico.readUInt32LE(18),ico.readUInt32LE(18)+ico.readUInt32LE(14));const hintedRaster=await sharp(Buffer.from(hinted)).resize(16,16).png().toBuffer();assert.deepEqual(first,hintedRaster,'ICO 16 px frame differs from hinted SVG');
for(const [name,width,height,alpha] of [
  ['apple-touch-icon.png',180,180,false],['icon-192.png',192,192,false],['icon-512.png',512,512,false],
  ['icon-maskable-192.png',192,192,false],['icon-maskable-512.png',512,512,false],['icon-monochrome-512.png',512,512,true],
  ['og-image.png',1200,630,false],['github-social-1280x640.png',1280,640,false],['app-store-1024.png',1024,1024,false]
]){const meta=await sharp(`${dir}/${name}`).metadata();assert.equal(meta.width,width,name);assert.equal(meta.height,height,name);assert.equal(meta.hasAlpha,alpha,name);}
for(const [name,size] of [['apple-touch-icon.png',180],['app-store-1024.png',1024]]){
  const {data,info}=await sharp(`${dir}/${name}`).raw().toBuffer({resolveWithObject:true});
  const background=[...data.subarray(0,3)];let x0=size,y0=size,x1=0,y1=0;
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const at=(y*size+x)*info.channels;
    if(data[at]!==background[0]||data[at+1]!==background[1]||data[at+2]!==background[2]){x0=Math.min(x0,x);x1=Math.max(x1,x);y0=Math.min(y0,y);y1=Math.max(y1,y);}
  }
  assert.ok(Math.abs((x1-x0+1)/size-.436)<.01,`${name} artwork width is not at 0.8 scale`);
  assert.ok(Math.abs((y1-y0+1)/size-.616)<.01,`${name} artwork height is not at 0.8 scale`);
  assert.ok(Math.abs((y0+y1+1)/(2*size)-.495)<.01,`${name} artwork is not vertically centred`);
}
for(const size of [192,512]){
  const {data,info}=await sharp(`${dir}/icon-maskable-${size}.png`).raw().toBuffer({resolveWithObject:true});
  const background=[...data.subarray(0,3)];let maxRadius=0;
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const at=(y*size+x)*info.channels;
    if(data[at]!==background[0]||data[at+1]!==background[1]||data[at+2]!==background[2])maxRadius=Math.max(maxRadius,Math.hypot(x+.5-size/2,y+.5-size/2));
  }
  assert.ok(maxRadius<=size*.36+1,`maskable ${size} extends to ${maxRadius/size}`);
}
const browser=await chromium.launch(),page=await browser.newPage();
await page.goto(pathToFileURL(resolve(`${dir}/favicon.svg`)).href);
await page.emulateMedia({colorScheme:'light'});assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).color),'rgb(40, 107, 76)');
await page.emulateMedia({colorScheme:'dark'});assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).color),'rgb(157, 213, 176)');
const mono=await readFile(`${dir}/mark-mono.svg`,'utf8');await page.goto('about:blank');await page.setContent(`<div style="color:rgb(180,20,50)">${mono}</div>`);
assert.equal(await page.locator('svg g').evaluate(node=>getComputedStyle(node).fill),'rgb(180, 20, 50)');
await browser.close();
console.log('Asset dimensions, alpha, master geometry, Apple scale, outlined wordmarks, ICO sizes, maskable safe area and colour switching pass.');
