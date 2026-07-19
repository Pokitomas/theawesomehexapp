async function loadSurfaceRouter(){
  try{
    const response=await fetch('./surface-perceptron-model.json',{cache:'no-store'});if(!response.ok)throw new Error(`HTTP ${response.status}`);
    const text=await response.text(),observed=await sha256(text);if(observed!==SURFACE_MODEL_SHA256)throw new Error('surface digest mismatch');
    const model=JSON.parse(text);if(model.schema!=='archie-screenshot-perceptron/v1'||model.model_id!=='archie-surface-perceptron-int8-v1')throw new Error('surface manifest mismatch');
    const raw=decodeWeights(model.weights_base64);if(raw.length!==model.input_dim*model.classes.length)throw new Error('surface weight shape mismatch');
    const weights=Array.from({length:model.classes.length},(_,c)=>{const row=new Float32Array(model.input_dim),scale=model.scales[c],offset=c*model.input_dim;for(let i=0;i<row.length;i++)row[i]=raw[offset+i]*scale;return row});
    surfaceRouter={...model,weights,digest:observed};
    const source=currentImage||demoImage;if(source){const analysis=analyzeCanvas(source);if(currentImage)currentImageAnalysis=analysis;renderImageWorkbench(source,analysis,currentImage?'local image':'demo source')}
    return true;
  }catch(error){surfaceRouter=null;return false}
}
function surfaceFeatures(canvas,side=8){const c=document.createElement('canvas');c.width=side;c.height=side;const x=c.getContext('2d',{willReadFrequently:true});x.drawImage(canvas,0,0,side,side);const data=x.getImageData(0,0,side,side).data,out=new Float32Array(side*side+1);for(let i=0,p=0;i<data.length;i+=4,p++){const l=.2126*data[i]+.7152*data[i+1]+.0722*data[i+2];out[p]=l/127.5-1}out[out.length-1]=1;return out}
function classifySurface(canvas){if(!surfaceRouter)return null;const x=surfaceFeatures(canvas,surfaceRouter.side),scores=new Float32Array(surfaceRouter.classes.length);for(let c=0;c<scores.length;c++){let z=0;const row=surfaceRouter.weights[c];for(let i=0;i<x.length;i++)z+=row[i]*x[i];scores[c]=z}const probs=softmax(scores);let best=0;for(let i=1;i<probs.length;i++)if(probs[i]>probs[best])best=i;return{class_name:surfaceRouter.classes[best],confidence:probs[best],scores:[...scores],model_id:surfaceRouter.model_id,model_sha256:surfaceRouter.digest,admitted:probs[best]>=surfaceRouter.confidence_threshold}}
