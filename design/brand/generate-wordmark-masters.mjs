import {execFileSync} from 'node:child_process';
import {writeFile} from 'node:fs/promises';

const outlines=JSON.parse(execFileSync('uv',['run','--frozen','--with','uharfbuzz==0.57.0','--with','brotli==1.2.1','python','design/brand/outline-wordmark.py'],{encoding:'utf8'}));
for(const [name,optical] of [['display',72],['header',48]]){
  const data=outlines[String(optical)],size=54,scale=size/data.upem,space=size*.25;
  const group=(word,x)=>{
    const paths=data.words[word].paths.map(path=>`<path d="${path.d}" transform="translate(${path.x} ${path.y})"/>`).join('');
    return `<g id="${word.toLowerCase()}" fill="currentColor" transform="translate(${x} 67) scale(${scale} ${-scale})">${paths}</g>`;
  };
  const second=data.words.Piano.advance*scale+space;
  const width=Math.ceil(second+data.words.Duet.advance*scale);
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="100" viewBox="0 0 ${width} 100" role="img" aria-label="Piano Duet">${group('Piano',0)}${group('Duet',second)}</svg>`;
  await writeFile(`design/brand/master/wordmark-${name}.svg`,svg);
}
console.log('Generated outlined Fraunces display and header wordmark masters.');
