mediaReady.then(()=>loadClassicScript('./archie-runtime-base.js')).catch(error=>{document.documentElement.dataset.archieBootError=error.message;console.error(error)});
