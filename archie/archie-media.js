var SURFACE_MODEL_SHA256='6703c4095dd8c2e65f58f8f4c5e18fbe51f2c93c8f71e3aeab363216a9aee705';
var surfaceRouter=null,surfaceReady=Promise.resolve(false),demoImage=null;
function loadClassicScript(src){return new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=src;script.async=false;script.onload=resolve;script.onerror=()=>reject(new Error(`Failed to load ${src}`));document.head.append(script)})}
var mediaReady=loadClassicScript('./archie-media-surface.js')
  .then(()=>{surfaceReady=loadSurfaceRouter();return Promise.all([surfaceReady,loadClassicScript('./archie-media-variants.js')])})
  .then(()=>loadClassicScript('./archie-media-image.js'))
  .then(()=>loadClassicScript('./archie-surface-bridge.js'));
