import { mkdir, rm, copyFile, writeFile, cp, access } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import readline from 'node:readline';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here=dirname(fileURLToPath(import.meta.url));
const root=join(here,'..');
const src=join(root,'src');
const dist=join(root,'dist');
const dataDir=join(dist,'data');
const contentDir=join(dataDir,'content');
const COUNT=Number(process.env.POST_COUNT||1_000_000);
const CHUNK_SIZE=Number(process.env.CHUNK_SIZE||1024);
const CONTENT_CHUNK_SIZE=Number(process.env.CONTENT_CHUNK_SIZE||128);
const SEED=Number(process.env.CORPUS_SEED||20260712)>>>0;
const CORPUS_FILE=process.env.CORPUS_FILE||join(root,'corpus/general-media.jsonl.gz');
const TYPES=['article','forum','social'];
const TYPE_INDEX=new Map(TYPES.map((x,i)=>[x,i]));
const AXES=['evidence','mechanism','history','implementation','comparison','primary-source','human-impact','local-context','counterargument','economics','design','culture'];
const FRAMES=['report','conversation','dispatch','explainer','argument','observation','investigation','personal-account','analysis'];
if(!Number.isInteger(COUNT)||COUNT<1)throw new Error('POST_COUNT must be positive');
if(!Number.isInteger(CHUNK_SIZE)||CHUNK_SIZE<64)throw new Error('CHUNK_SIZE must be >=64');

const clamp=(n,lo=0,hi=1)=>Math.max(lo,Math.min(hi,Number.isFinite(n)?n:lo));
const q=n=>Math.round(clamp(n)*100);
function hashString(value){let h=2166136261>>>0;for(let i=0;i<value.length;i++){h^=value.charCodeAt(i);h=Math.imul(h,16777619)}return h>>>0}
function hash32(n){n=(n+0x9e3779b9+SEED)>>>0;n^=n>>>16;n=Math.imul(n,0x21f0aaad);n^=n>>>15;n=Math.imul(n,0x735a2d97);n^=n>>>15;return n>>>0}
function rand(id,salt=0){return hash32((id^Math.imul(salt+1,0x85ebca6b))>>>0)/4294967296}
function tokens(text){return String(text||'').toLowerCase().match(/[a-z0-9][a-z0-9'-]{2,}/g)||[]}
function topicVector(record){const bins=new Array(8).fill(.05);for(const token of tokens(`${record.title} ${record.dek} ${record.text}`).slice(0,220)){const h=hashString(token);bins[h%8]+=1+((h>>>8)%5)/10}const norm=Math.sqrt(bins.reduce((s,x)=>s+x*x,0))||1;return bins.map(x=>q(x/norm))}
function textSignals(record){const text=`${record.title} ${record.dek} ${record.text} ${record.content_warning}`.toLowerCase();const graphicWords=['killed','dead','death','blood','attack','war','shooting','injured','violence'];const arousalWords=['breaking','urgent','shocking','angry','furious','crisis','wild','huge','disaster','explodes'];const positiveWords=['love','good','beautiful','hope','joy','great','fun','win','happy'];const negativeWords=['bad','hate','fear','loss','fail','sad','worse','crisis','dead'];const count=arr=>arr.reduce((n,w)=>n+(text.includes(w)?1:0),0);return {graphic:clamp(count(graphicWords)/4),arousal:clamp(.32+count(arousalWords)/6),valence:clamp(.5+(count(positiveWords)-count(negativeWords))/12)}}
function dateScore(value){const t=Date.parse(value||'');if(!Number.isFinite(t))return .35;const ageDays=Math.max(0,(Date.now()-t)/86400000);return clamp(Math.exp(-ageDays/2400))}
async function readCorpus(path){await access(path);const stream=createReadStream(path).pipe(createGunzip());const rl=readline.createInterface({input:stream,crlfDelay:Infinity});const out=[];for await(const line of rl){if(!line.trim())continue;const r=JSON.parse(line);if(!TYPE_INDEX.has(r.type)||!r.title||!r.canonical_url)continue;out.push(r)}return out}

const records=await readCorpus(CORPUS_FILE);
const pools=Object.fromEntries(TYPES.map(type=>[type,[]]));
records.forEach((record,index)=>pools[record.type].push(index));
for(const type of TYPES)if(!pools[type].length)throw new Error(`missing ${type} records`);

const sourceNames=[];const sourceUrls=[];const sourceMap=new Map();
const authors=[];const authorMap=new Map();
const mediaIndex=[];const mediaMap=new Map();
function sourceId(record){const key=`${record.source_name||'unknown'}\n${record.source_url||''}`;if(!sourceMap.has(key)){sourceMap.set(key,sourceNames.length);sourceNames.push(record.source_name||'unknown source');sourceUrls.push(record.source_url||'')}return sourceMap.get(key)}
function authorId(record){const key=`${record.author_name||'unknown'}\n${record.author_handle||''}\n${record.author_url||''}`;if(!authorMap.has(key)){authorMap.set(key,authors.length);authors.push({n:record.author_name||'unknown',h:record.author_handle||'',u:record.author_url||'',a:record.avatar||''})}return authorMap.get(key)}
function firstMediaId(record){const media=(record.media||[]).find(x=>x.card||x.preview||x.original);if(!media)return -1;const key=media.card||media.preview||media.original;if(!mediaMap.has(key)){mediaMap.set(key,mediaIndex.length);mediaIndex.push({c:media.card||media.preview||media.original,f:media.full||media.original||media.preview,o:media.original||'',a:media.alt||'',w:Number(media.width||0),h:Number(media.height||0),r:Number(media.aspect||0),k:media.kind||'image',s:media.source_url||''})}return mediaMap.get(key)}
function relatedFor(index){const record=records[index];const pool=pools[record.type];const pos=pool.indexOf(index);if(pos<0)return[];const out=[];for(const offset of [1,-1,7,-7,19,-19]){const candidate=pool[(pos+offset+pool.length)%pool.length];if(candidate!==index&&!out.includes(candidate))out.push(candidate)}return out}
function engagementArray(record){const e=record.engagement||{};if(record.type==='article')return[0,0,0];if(record.type==='forum')return[Number(e.points||0),Number(e.comments||0),0];return[Number(e.likes||0),Number(e.boosts||0),Number(e.replies||0)]}
function compactContent(record,index){return {i:index,p:String(record.native_id||''),y:record.published_at||'',ty:TYPE_INDEX.get(record.type),h:record.title,d:record.dek||'',tx:record.text||'',b:(record.body||[]).slice(0,22),s:sourceId(record),a:authorId(record),u:record.canonical_url||'',o:record.outbound_url||'',l:record.license||'',la:record.language||'',cw:record.content_warning||'',e:engagementArray(record),m:(record.media||[]).slice(0,8).map(x=>({k:x.kind||'image',c:x.card||x.preview||x.original||'',f:x.full||x.original||x.preview||'',o:x.original||'',a:x.alt||'',w:Number(x.width||0),h:Number(x.height||0),r:Number(x.aspect||0),s:x.source_url||''})),x:(record.sources||[]).slice(0,80).map(x=>({l:x.label||'',u:x.url||'',k:x.kind||'',p:x.publication||'',a:x.author||'',d:x.date||''})),r:(record.replies||[]).slice(0,18).map(x=>({i:String(x.id||''),a:x.author||'',t:x.text||'',y:x.published_at||'',u:x.url||'',c:Number(x.children||0)})),q:relatedFor(index),rev:record.revision||''}}

const compactRecords=records.map(compactContent);
const sourceIndex=Object.fromEntries(sourceNames.map((_,i)=>[i,[]]));
function candidate(id){const typeIndex=id%3;const type=TYPES[typeIndex];const pool=pools[type];const recordIndex=pool[Math.floor(rand(id,101)*pool.length)%pool.length];const record=records[recordIndex];const signals=textSignals(record);const vector=topicVector(record);const sid=sourceId(record);const aid=authorId(record);const mi=firstMediaId(record);const lateral=rand(id,8)>.56;const axes=[Math.floor(rand(id,9)*AXES.length),Math.floor(rand(id,10)*AXES.length),Math.floor(rand(id,11)*AXES.length)].filter((x,i,a)=>a.indexOf(x)===i);const recent=dateScore(record.published_at);const engagement=engagementArray(record);const engagementMagnitude=Math.log10(1+engagement.reduce((s,x)=>s+x,0))/5;const base=clamp(.28+.28*recent+.26*engagementMagnitude+.18*rand(id,12));const relevance=clamp(.30+.52*rand(id,13)+.18*(record.type==='social'?signals.arousal:.5));const context=clamp(record.type==='article'?.62:record.type==='forum'?.48:.34 + .25*rand(id,14));const mechanism=clamp(record.type==='article'?.58:record.type==='forum'?.50:.30 + .28*rand(id,15));const primary=record.type!=='article'||(record.sources||[]).length>2;const candidate={i:id,z:recordIndex,ty:typeIndex,s:sid,j:aid,h:record.title,d:record.dek||record.text?.slice(0,420)||'',im:mi,t:vector,v:Math.round((rand(id,16)*2-1)*100),g:q(signals.graphic),n:q(signals.valence),a:q(signals.arousal),u:recordIndex,f:Math.floor(rand(id,17)*FRAMES.length),x:axes,b:q(base),r:q(relevance),k:q(context),m:q(mechanism),p:primary?1:0,q:lateral?1:0,y:record.published_at||'',e:engagement};if(sourceIndex[sid].length<96)sourceIndex[sid].push(id);return candidate}

await rm(dist,{recursive:true,force:true});await mkdir(dataDir,{recursive:true});await mkdir(contentDir,{recursive:true});
for(const file of ['index.html','style.css','app.js'])await copyFile(join(src,file),join(dist,file));
try{await cp(join(root,'corpus/media'),join(dist,'media'),{recursive:true})}catch{}
for(let start=0;start<compactRecords.length;start+=CONTENT_CHUNK_SIZE){const chunk=compactRecords.slice(start,start+CONTENT_CHUNK_SIZE);await writeFile(join(contentDir,`${String(start/CONTENT_CHUNK_SIZE).padStart(5,'0')}.json`),JSON.stringify(chunk))}
const chunks=Math.ceil(COUNT/CHUNK_SIZE);for(let chunk=0;chunk<chunks;chunk++){const start=chunk*CHUNK_SIZE,end=Math.min(COUNT,start+CHUNK_SIZE);const out=new Array(end-start);for(let id=start;id<end;id++)out[id-start]=candidate(id);await writeFile(join(dataDir,`${String(chunk).padStart(6,'0')}.json`),JSON.stringify(out));if(chunk%100===0)process.stdout.write(`generated ${end.toLocaleString()} / ${COUNT.toLocaleString()}\r`)}
const typeCounts={article:Math.floor((COUNT+2)/3),forum:Math.floor((COUNT+1)/3),social:Math.floor(COUNT/3)};
const manifest={version:5,count:COUNT,chunkSize:CHUNK_SIZE,chunks,contentCount:records.length,contentChunkSize:CONTENT_CHUNK_SIZE,contentChunks:Math.ceil(records.length/CONTENT_CHUNK_SIZE),contentTypes:TYPES,sources:sourceNames,sourceUrls,authors,mediaIndex,axes:AXES,frames:FRAMES,candidateFields:{i:'candidate id',z:'content index',ty:'content type index',s:'source index',j:'author index',h:'title',d:'display text',im:'media index',t:'synthetic topic vector',v:'synthetic viewpoint',g:'synthetic graphic load',n:'synthetic valence',a:'synthetic arousal',u:'duplicate family',f:'frame index',x:'informational axes',b:'predicted engagement',r:'relevance',k:'context value',m:'mechanism value',p:'primary-source flag',q:'latent retrieval family',y:'published date',e:'engagement tuple'},contentFields:{i:'content index',p:'source-native id',y:'published date',ty:'content type',h:'title',d:'dek',tx:'social/forum text',b:'article body',s:'source index',a:'author index',u:'canonical URL',o:'outbound URL',l:'license',la:'language',cw:'content warning',e:'engagement',m:'media',x:'all actual source links',r:'forum replies',q:'related content'},corpus:{mode:'general-content-model',name:'actual article, forum, and social records',contentCount:records.length,uniqueByType:Object.fromEntries(TYPES.map(type=>[type,pools[type].length])),candidateByType:typeCounts,actualSources:true,categories:false,media:{mirrored:mediaIndex.filter(x=>x.c.startsWith('media/')).length,total:mediaIndex.length,cardMax:'1280x900 WebP',fullMax:'2200x1800 WebP'},note:'One million deterministic candidate instances reference unique source records. Retrieval metadata is synthetic; displayed text, authors, links, replies, and media provenance come from source records.'}};
await writeFile(join(dataDir,'manifest.json'),JSON.stringify(manifest));await writeFile(join(dataDir,'source-index.json'),JSON.stringify(sourceIndex));await writeFile(join(dataDir,'mix.json'),JSON.stringify({candidateByType:typeCounts,uniqueByType:manifest.corpus.uniqueByType,media:manifest.corpus.media}));
process.stdout.write(`\ndist ready: ${COUNT.toLocaleString()} candidates / ${records.length.toLocaleString()} actual records\n`);
