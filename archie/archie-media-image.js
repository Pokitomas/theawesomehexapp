function makeDemoImage(){
  const c=document.createElement('canvas');c.width=900;c.height=520;const x=c.getContext('2d');
  const g=x.createLinearGradient(0,0,c.width,c.height);g.addColorStop(0,'#0b0e12');g.addColorStop(.48,'#17313a');g.addColorStop(1,'#ff6c43');x.fillStyle=g;x.fillRect(0,0,c.width,c.height);
  x.globalCompositeOperation='screen';for(let i=0;i<26;i++){x.fillStyle=`hsla(${175+i*7},90%,60%,${.02+i*.002})`;x.beginPath();x.arc(180+i*22,260+Math.sin(i*.7)*85,25+i*4,0,Math.PI*2);x.fill()}x.globalCompositeOperation='source-over';
  x.fillStyle='#f2f0e8';x.font='900 92px Inter, sans-serif';x.fillText('ARCHIE',54,130);x.font='700 22px ui-monospace, monospace';x.fillText('SYNTHETIC DEMO FRAME / DROP YOUR OWN IMAGE',60,170);
  x.strokeStyle='rgba(215,255,67,.9)';x.lineWidth=2;for(let i=0;i<8;i++){x.strokeRect(560+i*13,215+i*11,180-i*18,180-i*15)}
  x.fillStyle='#d7ff43';x.beginPath();x.moveTo(90,420);x.lineTo(290,225);x.lineTo(410,420);x.closePath();x.fill();x.fillStyle='#050608';x.font='1000 82px Inter, sans-serif';x.fillText('A',215,397);
  demoImage=c;const analysis=analyzeCanvas(c);renderImageWorkbench(c,analysis,'demo source');
}
function analyzeCanvas(canvas){
  const sample=document.createElement('canvas');sample.width=128;sample.height=96;const s=sample.getContext('2d',{willReadFrequently:true});s.drawImage(canvas,0,0,128,96);const data=s.getImageData(0,0,128,96).data,hist=new Array(32).fill(0);let r=0,g=0,b=0,edge=0,energy=0;
  const lum=new Float32Array(128*96);for(let i=0,p=0;i<data.length;i+=4,p++){const rr=data[i],gg=data[i+1],bb=data[i+2],l=.2126*rr+.7152*gg+.0722*bb;lum[p]=l;hist[Math.min(31,l>>3)]++;r+=rr;g+=gg;b+=bb;energy+=Math.abs(rr-gg)+Math.abs(gg-bb)+Math.abs(bb-rr)}
  for(let y=1;y<95;y++)for(let x=1;x<127;x++){const i=y*128+x;edge+=Math.abs(lum[i+1]-lum[i-1])+Math.abs(lum[i+128]-lum[i-128])}
  const n=128*96;r/=n;g/=n;b/=n;let entropy=0;for(const count of hist){if(!count)continue;const p=count/n;entropy-=p*Math.log2(p)}entropy/=5;edge=Math.min(1,edge/(n*92));const warmth=Math.max(-1,Math.min(1,(r-b)/128)),brightness=(.2126*r+.7152*g+.0722*b)/255,saturation=Math.min(1,energy/(n*180));
  const tone=brightness>.66?'bright':brightness<.34?'dark':'mid-tone',temp=warmth>.14?'warm':warmth<-.14?'cool':'balanced',detail=edge>.42?'high-detail':edge<.18?'soft':'textured',color=saturation>.55?'vivid':saturation<.22?'muted':'colored';
  const signature=digest([r,g,b,entropy,edge,warmth,brightness,saturation].map(v=>Number(v).toFixed(4)).join('|'));
  const surface=classifySurface(canvas);return{r,g,b,entropy,edge,warmth,brightness,saturation,signature,surface,description:`${tone}, ${temp}, ${detail}, ${color} image`}
}
function renderImageWorkbench(source,analysis,label='local image'){
  const stage=$('imageStage'),ctx=stage.getContext('2d');ctx.clearRect(0,0,stage.width,stage.height);const scale=Math.min(stage.width/source.width,stage.height/source.height),w=source.width*scale,h=source.height*scale,x=(stage.width-w)/2,y=(stage.height-h)/2;ctx.fillStyle='#040506';ctx.fillRect(0,0,stage.width,stage.height);ctx.drawImage(source,x,y,w,h);ctx.strokeStyle='rgba(215,255,67,.8)';ctx.lineWidth=2;ctx.strokeRect(x+8,y+8,w-16,h-16);
  const routed=analysis.surface?` · layout ${analysis.surface.class_name} ${(analysis.surface.confidence*100).toFixed(0)}%`:'';$('imageHud').textContent=`entropy ${analysis.entropy.toFixed(3)} · edge ${analysis.edge.toFixed(3)} · warmth ${analysis.warmth.toFixed(3)}${routed} · sig ${analysis.signature}`;$('imageMetric').textContent=analysis.surface?`${label} · trained ${analysis.surface.class_name}`:label;
  const modes=['AURA','EDGES','HEAT','POSTER','MOSAIC','SPECTRUM'],$grid=$('pictureGrid');$grid.innerHTML='';for(const mode of modes){const card=document.createElement('div');card.className='picture-card';const c=document.createElement('canvas');c.width=220;c.height=220;renderVariant(source,c,mode,analysis);const span=document.createElement('span');span.textContent=mode;card.append(c,span);$grid.append(card)}
}
async function loadImage(file){if(!file)return;await surfaceReady;const bitmap=await createImageBitmap(file),c=document.createElement('canvas'),max=1400,scale=Math.min(1,max/Math.max(bitmap.width,bitmap.height));c.width=Math.max(1,Math.round(bitmap.width*scale));c.height=Math.max(1,Math.round(bitmap.height*scale));c.getContext('2d').drawImage(bitmap,0,0,c.width,c.height);bitmap.close();currentImage=c;currentImageAnalysis=analyzeCanvas(c);const preview=$('sourceCanvas'),p=preview.getContext('2d');preview.width=Math.min(900,c.width);preview.height=Math.round(c.height*(preview.width/c.width));p.drawImage(c,0,0,preview.width,preview.height);$('inputPreview').hidden=false;renderImageWorkbench(c,currentImageAnalysis,`${file.name} · ${(file.size/1024).toFixed(0)} KB`)}
