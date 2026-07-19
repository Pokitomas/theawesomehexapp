const archieBaseGenerate=generate;
generate=function(t,m,image){
  const response=archieBaseGenerate(t,m,image);
  if(!image?.surface)return response;
  const route=`Trained screenshot route: ${image.surface.class_name} (${(image.surface.confidence*100).toFixed(1)}%). Boundary: coarse layout only; no OCR, object recognition, or arbitrary-photo understanding.`;
  return `${route}\n\n${response}`;
};
surfaceReady=loadSurfaceRouter();
