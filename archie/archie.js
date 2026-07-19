const KEY='archie-multimodal-substrate/v1',MAX=30,MODEL_SHA256='202a6957bd0bbf0a9b4e92cd74014b2b9689393be539de8f5ab44f567a691916',$=id=>document.getElementById(id),clean=v=>String(v||'').replace(/\r/g,'').trim(),compact=v=>clean(v).replace(/\s+/g,' '),esc=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ACTIVE_PRIMITIVES=new Set(['see','hear','route','compose','compress','speak']);
const names={summary:'Summary',checklist:'Checklist',message:'Message draft',decision:'Decision aid',study:'Study breakdown',event:'Event plan',errands:'Errand plan',objective:'Objective',next_action:'Next action',plan:'Short plan'};
const state=load();
let neuralRouter=null,modelReady=null,currentImage=null,currentImageAnalysis=null,currentResult=null,voiceSession=null,showcaseRecorder=null,showcaseStream=null,student=null,selectedBits=8;

function load(){try{const x=JSON.parse(localStorage.getItem(KEY)||'{}');return{history:Array.isArray(x.history)?x.history:[],activeObjective:typeof x.activeObjective==='string'?x.activeObjective:''}}catch{return{history:[],activeObjective:''}}}
function save(){try{localStorage.setItem(KEY,JSON.stringify(state))}catch{}}
function digest(v){let h=2166136261;for(const c of v){h^=c.charCodeAt(0);h=Math.imul(h,16777619)}return(h>>>0).toString(16).padStart(8,'0')}
async function sha256(text){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));return[...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,'0')).join('')}
function fnv1a(value){let h=2166136261;for(const c of value){h^=c.charCodeAt(0);h=Math.imul(h,16777619)}return h>>>0}
function neuralFeatures(text,dimension){const words=text.toLowerCase().replace(/[^a-z0-9\s]+/g,' ').split(/\s+/).filter(Boolean),features=words.map(x=>`w:${x}`);for(let i=0;i<words.length-1;i++)features.push(`b:${words[i]}_${words[i+1]}`);const joined=words.join(' ');for(let i=0;i<Math.max(0,joined.length-2);i++)features.push(`c:${joined.slice(i,i+3)}`);const counts=new Map();for(const feature of features){const index=fnv1a(feature)%dimension;counts.set(index,(counts.get(index)||0)+1)}let norm=0;const values=[];for(const[index,count]of counts){const value=Math.log1p(count);norm+=value*value;values.push([index,value])}norm=Math.sqrt(norm)||1;return values.map(([index,value])=>[index,value/norm])}
function decodeWeights(value){const binary=atob(value),out=new Int8Array(binary.length);for(let i=0;i<binary.length;i++){const byte=binary.charCodeAt(i);out[i]=byte>127?byte-256:byte}return out}

async function loadNeuralRouter(){
  try{
    const response=await fetch('./router-model.json',{cache:'no-store'});if(!response.ok)throw new Error(`HTTP ${response.status}`);
    const text=await response.text(),observed=await sha256(text);if(observed!==MODEL_SHA256)throw new Error('digest mismatch');
    const model=JSON.parse(text);if(model.schema!=='archie-local-neural-router/v1'||model.model_id!=='archie-router-bytehash-perceptron-v1')throw new Error('manifest mismatch');
    const weights=decodeWeights(model.weights_base64),classes=model.classes.length;if(weights.length!==model.feature_dim*classes)throw new Error('weight shape mismatch');
    neuralRouter={...model,weights,digest:observed};
    $('modelState').textContent='Admitted local neural router verified.';$('modelState').classList.add('verified');
    $('modelDetail').textContent=`${model.model_id} · ${observed.slice(0,12)}…`;
    $('featureDim').textContent=`${model.feature_dim.toLocaleString()} sparse dimensions`;$('classCount').textContent=`${classes} task classes`;
    $('runtimeDot').classList.add('ready');$('runtimeLabel').textContent='verified local router online';
    return true;
  }catch(error){
    neuralRouter=null;$('modelState').textContent='Neural router unavailable.';$('modelDetail').textContent='deterministic fallback · neural evidence false';
    $('runtimeDot').classList.add('warn');$('runtimeLabel').textContent='deterministic fail-closed mode';return false;
  }
}
function neuralMode(text){if(!neuralRouter)return null;const model=neuralRouter,classes=model.classes.length,scores=model.bias.slice();for(const[index,value]of neuralFeatures(text,model.feature_dim)){const offset=index*classes;for(let c=0;c<classes;c++)scores[c]+=model.weights[offset+c]*model.scales[c]*value}const order=scores.map((score,index)=>({score,index})).sort((a,b)=>a.score-b.score),winner=order.at(-1),runnerUp=order.at(-2),margin=winner.score-runnerUp.score;if(margin<model.margin_threshold)return null;return{mode:model.classes[winner.index],margin,model_id:model.model_id,model_sha256:model.digest,scores}}
function core(t){return compact(t).replace(/^(please\s+)?archie[, :]*/i,'').replace(/^(turn|make|draft|write|summarize|organize|plan|help me|break down|track)\s+(this|me|a|an|my)?\s*/i,'').replace(/^(messy thought|text|message|checklist|assignment|event|objective|goal)\s*(into|for|that says|:|-)?\s*/i,'').trim()||compact(t)}
function parts(t){return[...new Set(clean(t).split(/\n|;|,(?=\s)|\band then\b|\bthen\b/i).map(compact).filter(Boolean))].slice(0,8)}
function deterministicMode(t){const s=t.toLowerCase();if(/\b(summarize|summary|tl;dr|tldr)\b/.test(s))return'summary';if(/\b(checklist|check list|to[- ]?do|tasks?)\b/.test(s))return'checklist';if(/\b(draft|write|reply|respond|text|email|message)\b/.test(s))return'message';if(/\b(decide|decision|choose|which should|pros and cons)\b|\sor\s/.test(s))return'decision';if(/\b(assignment|study|exam|homework|class|essay|project due)\b/.test(s))return'study';if(/\b(event|party|dinner|meeting|hangout|birthday|picnic)\b/.test(s))return'event';if(/\b(errand|grocer|shopping|pick up|drop off|appointments?)\b/.test(s))return'errands';if(/\b(track|active objective|active goal|my goal)\b/.test(s))return'objective';if(/\b(next|what do i do|stuck|first step)\b/.test(s))return'next_action';return'plan'}
function generate(t,m,image){
  const s=core(t||'Use the attached image');let response='';
  if(m==='summary'){const a=clean(s).replace(/\n+/g,' ').split(/(?<=[.!?])\s+/).map(compact).filter(Boolean).slice(0,3);response=a.length?a.map((x,i)=>`${i+1}. ${x}`).join('\n'):'Nothing useful was provided to summarize.'}
  else if(m==='checklist'){let a=parts(s);if(a.length<2)a=[`Define the finished outcome for ${s}`,'Gather the minimum information or materials needed','Do the first concrete step','Check the result and close the loop'];response=a.map(x=>`☐ ${x.replace(/[.!]+$/,'')}`).join('\n')}
  else if(m==='message'){const b=s.replace(/^that says\s*:?\s*/i,'')||'I wanted to follow up and see where things stand.';const hi=/recruit|job|interview|manager|professional|email/i.test(t)?'Hi —':'Hey —';response=`${hi}\n\n${b.charAt(0).toUpperCase()}${b.slice(1).replace(/[.!?]*$/,'.')}\n\nThanks!`}
  else if(m==='decision'){const x=s.match(/(?:between\s+)?(.+?)\s+or\s+(.+?)(?:[.?!]|$)/i);response=x?`Call: choose ${compact(x[1])}.\n\nWhy: start with the option that is easier to reverse and more likely to produce new information. Choose ${compact(x[2])} only if it clearly protects a deadline, safety, or a commitment you already made.`:'Call: take the smallest reversible option that creates real information today. Delay only when a specific missing fact is scheduled to arrive.'}
  else if(m==='study')response=`Assignment: ${s.replace(/[.!?]+$/,'')}\n\n1. Write the exact deliverable and deadline.\n2. Split it into research, rough draft, revision, and submission.\n3. Do one 25-minute block on the first unfinished part.\n4. Leave the last block for checking the rubric and submitting.`;
  else if(m==='event')response=`Event: ${s.replace(/[.!?]+$/,'')}\n\n☐ Confirm the purpose, date, time, and place\n☐ Make the guest list and send one clear invitation\n☐ Decide food, supplies, and a simple budget\n☐ Set one reminder 24 hours before\n☐ Keep one backup plan for weather or cancellations`;
  else if(m==='errands'){const a=parts(s),list=a.length>1?a:[s];response=`Errand run\n\n${list.map((x,i)=>`${i+1}. ${x.replace(/[.!]+$/,'')}`).join('\n')}\n\nRoute rule: group stops by area, do anything time-sensitive first, and finish with groceries or temperature-sensitive items.`}
  else if(m==='objective'){state.activeObjective=s.replace(/^(objective|goal)\s*:?\s*/i,'');response=`Active objective saved: ${state.activeObjective.replace(/[.!?]+$/,'')}.\n\nNext checkpoint: define one result you can verify today, then record the outcome here.`}
  else if(m==='next_action')response=`Next action: spend 10 minutes producing the smallest visible piece of progress on “${s}.”\n\nStop after that step and reassess from what changed.`;
  else response=`1. Name the outcome: ${s.replace(/[.!?]+$/,'')}.\n2. Do the smallest action that creates visible progress or a response today.\n3. Set one checkpoint, then stop planning until you have new information.`;
  if(image){const lead=`Image read: ${image.description}. Signature ${image.signature}.`;response=`${lead}\n\n${response}`}
  return response;
}

function initMotionField(){
  const canvas=$('motionField'),ctx=canvas.getContext('2d'),points=[];let w=0,h=0,dpr=1,raf=0;
  function resize(){dpr=Math.min(devicePixelRatio||1,2);w=innerWidth;h=innerHeight;canvas.width=w*dpr;canvas.height=h*dpr;canvas.style.width=`${w}px`;canvas.style.height=`${h}px`;ctx.setTransform(dpr,0,0,dpr,0,0);points.length=0;const count=Math.min(78,Math.max(34,Math.floor(w/20)));for(let i=0;i<count;i++)points.push({x:Math.random()*w,y:Math.random()*h,vx:(Math.random()-.5)*.18,vy:(Math.random()-.5)*.18,r:Math.random()*1.7+.35,p:Math.random()*Math.PI*2})}
  function draw(t){ctx.clearRect(0,0,w,h);for(const p of points){p.x+=p.vx;p.y+=p.vy;p.p+=.012;if(p.x<-20)p.x=w+20;if(p.x>w+20)p.x=-20;if(p.y<-20)p.y=h+20;if(p.y>h+20)p.y=-20;const a=.1+Math.sin(p.p+t*.0002)*.05;ctx.fillStyle=`rgba(77,232,255,${a})`;ctx.beginPath();ctx.arc(p.x,p.y,p.r,0,Math.PI*2);ctx.fill()}ctx.strokeStyle='rgba(255,255,255,.025)';ctx.lineWidth=1;for(let y=0;y<h;y+=80){ctx.beginPath();for(let x=0;x<=w;x+=30){const yy=y+Math.sin(x*.008+t*.00025+y)*9;ctx.lineTo(x,yy)}ctx.stroke()}raf=requestAnimationFrame(draw)}
  addEventListener('resize',resize,{passive:true});resize();if(!matchMedia('(prefers-reduced-motion: reduce)').matches)raf=requestAnimationFrame(draw);return()=>cancelAnimationFrame(raf)
}
