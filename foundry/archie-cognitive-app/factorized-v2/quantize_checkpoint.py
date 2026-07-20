import json,hashlib
from pathlib import Path
import numpy as np, torch
src=Path('artifacts/byte-gru-v2.pt');ck=torch.load(src,map_location='cpu',weights_only=True);payload={};meta={'config':ck['config'],'routes':ck['routes'],'tensors':{}}
for k,v in ck['state_dict'].items():
 a=v.detach().cpu().numpy().astype(np.float32);mx=float(np.max(np.abs(a)));scale=mx/127 if mx else 1.0;q=np.clip(np.rint(a/scale),-127,127).astype(np.int8);payload[k]=q;meta['tensors'][k]={'scale':scale,'shape':list(a.shape)}
payload['__meta__']=np.array(json.dumps(meta));out=Path('artifacts/byte-gru-v2.int8.npz');np.savez_compressed(out,**payload)
print(json.dumps({'schema':'archie-byte-gru-int8/v1','source_sha256':hashlib.sha256(src.read_bytes()).hexdigest(),'artifact_sha256':hashlib.sha256(out.read_bytes()).hexdigest(),'bytes':out.stat().st_size,'tensors':len(ck['state_dict'])},indent=2))
