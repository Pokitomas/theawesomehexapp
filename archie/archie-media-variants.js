function renderVariant(source,canvas,mode,a){
  const x=canvas.getContext('2d',{willReadFrequently:true});x.drawImage(source,0,0,canvas.width,canvas.height);let im=x.getImageData(0,0,canvas.width,canvas.height),d=im.data;
  if(mode==='MOSAIC'){const size=12,copy=document.createElement('canvas');copy.width=canvas.width/size;copy.height=canvas.height/size;copy.getContext('2d').drawImage(source,0,0,copy.width,copy.height);x.imageSmoothingEnabled=false;x.clearRect(0,0,canvas.width,canvas.height);x.drawImage(copy,0,0,canvas.width,canvas.height);return}
  const lumAt=i=>.2126*d[i]+.7152*d[i+1]+.0722*d[i+2];
  for(let y=0;y<canvas.height;y++)for(let z=0;z<canvas.width;z++){const i=(y*canvas.width+z)*4,r=d[i],g=d[i+1],b=d[i+2],l=lumAt(i);
    if(mode==='AURA'){const wave=Math.sin(z*.07)+Math.cos(y*.05);d[i]=Math.min(255,r*.72+40+wave*12);d[i+1]=Math.min(255,g*.78+80);d[i+2]=Math.min(255,b*.92+95-wave*9)}
    else if(mode==='EDGES'){const ri=z<canvas.width-1?lumAt(i+4):l,bi=y<canvas.height-1?lumAt(i+canvas.width*4):l,e=Math.min(255,(Math.abs(ri-l)+Math.abs(bi-l))*4.2);d[i]=e*.35;d[i+1]=e;d[i+2]=e*.84}
    else if(mode==='HEAT'){d[i]=Math.min(255,l*1.7);d[i+1]=Math.max(0,255-Math.abs(l-128)*2);d[i+2]=Math.max(0,220-l*1.2)}
    else if(mode==='POSTER'){const q=Math.round(l/64)*64;d[i]=q+(r>g?35:0);d[i+1]=q+(g>b?25:0);d[i+2]=q+(b>r?45:0)}
    else if(mode==='SPECTRUM'){const h=(Math.atan2(Math.sqrt(3)*(g-b),2*r-g-b)/Math.PI+1)/2;d[i]=255*Math.abs(Math.sin(h*Math.PI));d[i+1]=255*Math.abs(Math.sin((h+.33)*Math.PI));d[i+2]=255*Math.abs(Math.sin((h+.66)*Math.PI))}
  }x.putImageData(im,0,0);if(mode==='AURA'){x.strokeStyle=`rgba(${a.r|0},${a.g|0},${a.b|0},.8)`;x.lineWidth=7;x.strokeRect(5,5,210,210)}
}
