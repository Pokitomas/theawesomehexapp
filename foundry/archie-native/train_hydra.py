#!/usr/bin/env python3
"""From-scratch Archie Hydra: selective SSM + sparse causal attention."""
from __future__ import annotations
import argparse,array,dataclasses,hashlib,json,math,os,pathlib,random,resource,sys,time
from dataclasses import dataclass
from typing import Any
import torch
import torch.nn as nn
import torch.nn.functional as F

PAD,BOS,EOS,SEP=256,257,258,259
VOCAB=260
METHOD="archie-hydra-selective-ssm-attention/v1"

def stable(x:Any)->str:return json.dumps(x,sort_keys=True,separators=(",",":"),ensure_ascii=False)
def dg(x:Any)->str:return hashlib.sha256((x if isinstance(x,bytes) else stable(x).encode())).hexdigest()
def sha(p:pathlib.Path)->str:return dg(p.read_bytes())
def rss()->int:
 v=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
 return int(v*1024) if sys.platform.startswith("linux") else int(v)
def mem()->int|None:
 p=pathlib.Path('/proc/meminfo')
 if p.exists():
  for line in p.read_text().splitlines():
   if line.startswith('MemTotal:'):return int(line.split()[1])*1024
 return None

class ByteTok:
 @staticmethod
 def enc(s:str,bos=False,eos=False)->list[int]:
  x=list(s.encode('utf-8',errors='replace'))
  return ([BOS] if bos else [])+x+([EOS] if eos else [])
 @staticmethod
 def dec(x)->str:return bytes(int(i) for i in x if 0<=int(i)<256).decode('utf-8',errors='replace')

EXT={'.c','.cc','.cpp','.css','.csv','.go','.h','.hpp','.html','.java','.js','.json','.jsonl','.jsx','.md','.mjs','.py','.rs','.sh','.sql','.toml','.ts','.tsx','.txt','.xml','.yaml','.yml'}
BAD={'.git','.next','.venv','__pycache__','artifacts','build','checkpoints','coverage','dist','models','node_modules','output','outputs','target','tmp','vendor'}
LOCK={'package-lock.json','pnpm-lock.yaml','yarn.lock','npm-shrinkwrap.json'}
def corpus(repo:pathlib.Path,out:pathlib.Path,max_bytes:int)->dict:
 out.mkdir(parents=True,exist_ok=True);tr=[BOS];dv=[BOS];rows=[]
 for p in sorted(x for x in repo.rglob('*') if x.is_file()):
  rel=p.relative_to(repo);parts={x.lower() for x in rel.parts}
  if parts&BAD or p.name.lower() in LOCK or p.suffix.lower() not in EXT or not 0<p.stat().st_size<=max_bytes:continue
  raw=p.read_bytes()
  if b'\0' in raw or sum(c<9 or 13<c<32 for c in raw[:8192])/max(1,len(raw[:8192]))>=.03:continue
  raw=raw.replace(b'\r\n',b'\n').replace(b'\r',b'\n');name=rel.as_posix();h=dg(raw)
  split='development' if int(h[:8],16)%20==0 else 'train';payload=list(f'\n<|file:{name}|>\n'.encode()+raw)+[SEP]
  (dv if split=='development' else tr).extend(payload);rows.append({'path':name,'bytes':len(raw),'sha256':h,'split':split})
 tr.append(EOS);dv.append(EOS)
 if len(dv)<4096 and rows:
  r=rows[-1];raw=(repo/r['path']).read_bytes();dv=[BOS]+list(f"\n<|file:{r['path']}|>\n".encode()+raw)+[SEP,EOS]
 for name,data in [('train',tr),('development',dv)]:(out/f'{name}.bin').write_bytes(array.array('H',data).tobytes())
 body={'schema':'archie-native-corpus/v1','files':rows,'counts':{'files':len(rows),'train_tokens':len(tr),'development_tokens':len(dv)},'train_sha256':sha(out/'train.bin'),'development_sha256':sha(out/'development.bin')}
 body['digest']=dg(body);(out/'manifest.json').write_text(json.dumps(body,indent=2,sort_keys=True)+'\n');return body

def load_u16(p:pathlib.Path)->torch.Tensor:
 a=array.array('H');a.frombytes(p.read_bytes());return torch.tensor(a,dtype=torch.long)

@dataclass
class Cfg:
 d:int=384;layers:int=12;heads:int=6;ff:int=1024;expand:int=2;ssm_heads:int=12;state:int=8;attn_every:int=4;drop:float=.05;seq:int=256
 def check(self):assert self.d%self.heads==0 and self.d*self.expand%self.ssm_heads==0
PRESET={
 'test':Cfg(64,3,4,160,2,4,4,3,0,32),
 'hosted':Cfg(),
 'large':Cfg(768,24,12,2304,2,24,16,4,.05,1024),
 'huge':Cfg(2048,36,16,6144,2,32,32,4,.05,4096),
}

class RMS(nn.Module):
 def __init__(self,d):super().__init__();self.w=nn.Parameter(torch.ones(d))
 def forward(self,x):return x*torch.rsqrt(x.float().pow(2).mean(-1,keepdim=True)+1e-6).to(x.dtype)*self.w
class Attn(nn.Module):
 def __init__(self,c):
  super().__init__();self.h=c.heads;self.hd=c.d//c.heads;self.qkv=nn.Linear(c.d,3*c.d,bias=False);self.o=nn.Linear(c.d,c.d,bias=False);self.drop=c.drop
  self.register_buffer('inv',1/(10000**(torch.arange(0,self.hd,2).float()/self.hd)),persistent=False)
 def forward(self,x):
  b,t,d=x.shape;q,k,v=self.qkv(x).chunk(3,-1);q=q.view(b,t,self.h,self.hd).transpose(1,2);k=k.view(b,t,self.h,self.hd).transpose(1,2);v=v.view(b,t,self.h,self.hd).transpose(1,2)
  f=torch.outer(torch.arange(t,device=x.device,dtype=self.inv.dtype),self.inv.to(x.device));a=torch.cat([f,f],-1);co,si=a.cos()[None,None].to(x.dtype),a.sin()[None,None].to(x.dtype)
  def rot(z):u,w=z.chunk(2,-1);return torch.cat([-w,u],-1)
  q,k=q*co+rot(q)*si,k*co+rot(k)*si;y=F.scaled_dot_product_attention(q,k,v,dropout_p=self.drop if self.training else 0,is_causal=True)
  return self.o(y.transpose(1,2).contiguous().view(b,t,d))
class SSM(nn.Module):
 def __init__(self,c):
  super().__init__();self.inner=c.d*c.expand;self.h=c.ssm_heads;self.hd=self.inner//self.h;self.n=c.state
  self.i=nn.Linear(c.d,2*self.inner,bias=False);self.conv=nn.Conv1d(self.inner,self.inner,4,groups=self.inner,padding=3);self.sel=nn.Linear(self.inner,self.h*(1+2*self.n));self.A=nn.Parameter(torch.empty(self.h,self.hd,self.n));self.D=nn.Parameter(torch.ones(self.h,self.hd));self.o=nn.Linear(self.inner,c.d,bias=False);self.dp=nn.Dropout(c.drop);nn.init.uniform_(self.A,math.log(.02),math.log(.2))
 def forward(self,x):
  b,t,_=x.shape;u,g=self.i(x).chunk(2,-1);u=F.silu(self.conv(u.transpose(1,2))[...,:t].transpose(1,2));p=self.sel(u).view(b,t,self.h,1+2*self.n);dt,B,C=torch.split(p,[1,self.n,self.n],-1);dt=.01+.09*torch.sigmoid(dt);B,C=torch.tanh(B),torch.tanh(C);uh=u.view(b,t,self.h,self.hd)
  dec=torch.exp(-dt.unsqueeze(-2)*torch.exp(self.A)[None,None]);inj=(1-dec)*uh.unsqueeze(-1)*B.unsqueeze(-2);pre=torch.cumprod(dec.float(),1).clamp_min(1e-20);st=pre*torch.cumsum(inj.float()/pre,1);y=(st*C.float().unsqueeze(-2)).sum(-1).to(x.dtype)+self.D[None,None]*uh
  return self.dp(self.o(y.reshape(b,t,self.inner)*F.silu(g)))
class FF(nn.Module):
 def __init__(self,c):super().__init__();self.u=nn.Linear(c.d,2*c.ff,bias=False);self.d=nn.Linear(c.ff,c.d,bias=False);self.dp=nn.Dropout(c.drop)
 def forward(self,x):g,v=self.u(x).chunk(2,-1);return self.dp(self.d(F.silu(g)*v))
class Block(nn.Module):
 def __init__(self,c,i):super().__init__();self.n1=RMS(c.d);self.n2=RMS(c.d);self.m=Attn(c) if (i+1)%c.attn_every==0 else SSM(c);self.f=FF(c);self.s=1/math.sqrt(2*c.layers)
 def forward(self,x):x=x+self.s*self.m(self.n1(x));return x+self.s*self.f(self.n2(x))
class Hydra(nn.Module):
 def __init__(self,c):
  super().__init__();c.check();self.c=c;self.e=nn.Embedding(VOCAB,c.d);self.dp=nn.Dropout(c.drop);self.b=nn.ModuleList(Block(c,i) for i in range(c.layers));self.n=RMS(c.d);self.lm=nn.Linear(c.d,VOCAB,bias=False);self.lm.weight=self.e.weight;self.apply(self.init)
 @staticmethod
 def init(m):
  if isinstance(m,(nn.Linear,nn.Embedding)):nn.init.normal_(m.weight,0,.02)
 def forward(self,x,y=None):
  z=self.dp(self.e(x))
  for b in self.b:z=b(z)
  l=self.lm(self.n(z));return l,None if y is None else F.cross_entropy(l.flatten(0,1),y.flatten())
 @torch.no_grad()
 def gen(self,x,n):
  for _ in range(n):
   l,_=self(x[:,-self.c.seq:]);q=l[:,-1]/.8;v,_=torch.topk(q,min(40,q.shape[-1]));q[q<v[:,-1,None]]=-float('inf');x=torch.cat([x,torch.multinomial(F.softmax(q,-1),1)],1)
  return x

def params(c):
 with torch.device('meta'):m=Hydra(c)
 return sum(p.numel() for p in m.parameters())
def batch(tok,b,s,g):
 if len(tok)<=s+1:tok=tok.repeat(math.ceil((s+2)/len(tok)))
 o=torch.randint(0,len(tok)-s-1,(b,),generator=g);return torch.stack([tok[i:i+s] for i in o]),torch.stack([tok[i+1:i+s+1] for i in o])
@torch.no_grad()
def eval_(m,tok,b,s,n,seed):
 m.eval();g=torch.Generator().manual_seed(seed);ls=[]
 for _ in range(n):x,y=batch(tok,b,s,g);_,l=m(x,y);ls.append(float(l))
 z=sum(ls)/len(ls);return {'loss':z,'byte_perplexity':math.exp(min(20,z))}
def lr(step,total,warm,peak):
 if step<warm:return peak*(step+1)/max(1,warm)
 p=(step-warm)/max(1,total-warm);return peak*(.1+.9*.5*(1+math.cos(math.pi*min(1,p))))
def save(p,m,opt,step,tokens,best,hist):p.parent.mkdir(parents=True,exist_ok=True);torch.save({'config':dataclasses.asdict(m.c),'model':m.state_dict(),'optimizer':opt.state_dict(),'step':step,'tokens':tokens,'best':best,'history':hist,'rng':torch.get_rng_state()},p)
def artifacts(root):return [{'path':p.relative_to(root).as_posix(),'bytes':p.stat().st_size,'sha256':sha(p)} for p in sorted(x for x in root.rglob('*') if x.is_file())]

def train(a):
 out=pathlib.Path(a.output).resolve();repo=pathlib.Path(a.repo).resolve();out.mkdir(parents=True,exist_ok=True);man=corpus(repo,out/'corpus',a.max_file_bytes);tr,dv=load_u16(out/'corpus/train.bin'),load_u16(out/'corpus/development.bin')
 c=dataclasses.replace(PRESET[a.preset],seq=a.seq);random.seed(a.seed);torch.manual_seed(a.seed);torch.set_num_threads(a.threads)
 try:torch.set_num_interop_threads(1)
 except RuntimeError:pass
 m=Hydra(c);opt=torch.optim.AdamW(m.parameters(),lr=a.learning_rate,betas=(.9,.95),weight_decay=.1);start=tokens=0;best=float('inf');hist=[];latest=out/'checkpoints/latest.pt'
 if a.resume and latest.exists():
  q=torch.load(latest,map_location='cpu',weights_only=False);m.load_state_dict(q['model']);opt.load_state_dict(q['optimizer']);start,tokens,best,hist=q['step'],q['tokens'],q['best'],q['history'];torch.set_rng_state(q['rng'])
 eff=a.batch*a.seq*a.accum;total=min(a.max_steps,max(1,math.ceil(len(tr)*a.epochs/eff)));warm=max(1,int(total*.03));deadline=time.monotonic()+a.minutes*60;g=torch.Generator().manual_seed(a.seed+start);initial=eval_(m,dv,a.eval_batch,a.seq,a.eval_batches,a.seed+9_000);best=min(best,initial['loss']);opt.zero_grad(set_to_none=True)
 for step in range(start,total):
  m.train();lossv=0
  for _ in range(a.accum):x,y=batch(tr,a.batch,a.seq,g);_,loss=m(x,y);(loss/a.accum).backward();lossv+=float(loss.detach())/a.accum
  gn=float(torch.nn.utils.clip_grad_norm_(m.parameters(),1));rate=lr(step,total,warm,a.learning_rate)
  for group in opt.param_groups:group['lr']=rate
  opt.step();opt.zero_grad(set_to_none=True);tokens+=eff;done=step+1;r={'step':done,'loss':lossv,'lr':rate,'grad_norm':gn,'tokens':tokens,'epochs':tokens/max(1,len(tr)),'rss':rss()}
  if done%a.eval_every==0 or done==total:
   e=eval_(m,dv,a.eval_batch,a.seq,a.eval_batches,a.seed+done);r['development']=e
   if e['loss']<best:best=e['loss'];save(out/'checkpoints/best.pt',m,opt,done,tokens,best,hist+[r])
  hist.append(r)
  if done==1 or done%a.log_every==0:print(stable(r),flush=True)
  if done%a.checkpoint_every==0 or done==total:save(latest,m,opt,done,tokens,best,hist)
  if time.monotonic()>=deadline:save(latest,m,opt,done,tokens,best,hist);break
 final=eval_(m,dv,a.eval_batch,a.seq,max(8,a.eval_batches),a.seed+19_000);model=out/'model';model.mkdir(exist_ok=True);torch.save(m.state_dict(),model/'model.pt');(model/'config.json').write_text(json.dumps({'schema':'archie-hydra-model/v1','config':dataclasses.asdict(c)},indent=2)+'\n');(model/'tokenizer.json').write_text(json.dumps({'schema':'archie-byte-tokenizer/v1','vocab':VOCAB,'special':{'pad':PAD,'bos':BOS,'eos':EOS,'sep':SEP}},indent=2)+'\n');sample=ByteTok.dec(m.gen(torch.tensor([ByteTok.enc('<|file:README.md|>\n# Archie\n',bos=True)]),a.sample)[0]);(out/'sample.txt').write_text(sample,errors='replace');(out/'history.json').write_text(json.dumps(hist,indent=2)+'\n')
 body={'schema':'archie-native-hydra-training-receipt/v1','method':METHOD,'source':{'repository':os.getenv('GITHUB_REPOSITORY') or str(repo),'revision':os.getenv('GITHUB_SHA'),'corpus_digest':man['digest'],'corpus_counts':man['counts']},'model':{'random_initialization':True,'pretrained':False,'teacher':None,'distillation':False,'preset':a.preset,'config':dataclasses.asdict(c),'parameters':sum(p.numel() for p in m.parameters()),'large_parameters':params(PRESET['large']),'huge_parameters':params(PRESET['huge'])},'training':{'steps':hist[-1]['step'] if hist else start,'tokens':tokens,'corpus_epochs':tokens/max(1,len(tr)),'initial_development':initial,'final_development':final,'best_loss':best,'time_budget_minutes':a.minutes},'runtime':{'torch':torch.__version__,'threads':torch.get_num_threads(),'memory_total':mem(),'max_rss':rss(),'runner':os.getenv('RUNNER_NAME')},'promotion':'not-admitted','claim_boundary':'Bounded from-scratch repository-corpus training only; no general competence, convergence, production, or admission claim.'};body['artifacts']=artifacts(out);rec={**body,'receipt_digest':dg(body)};(out/'training-receipt.json').write_text(json.dumps(rec,indent=2,sort_keys=True)+'\n');print(json.dumps(rec,indent=2,sort_keys=True))

def selftest():
 c=PRESET['test'];m=Hydra(c);x=torch.randint(0,VOCAB,(2,c.seq));l,loss=m(x,x);assert l.shape==(2,c.seq,VOCAB) and torch.isfinite(loss);loss.backward();assert sum(p.grad is not None for p in m.parameters())>10;assert m.gen(x[:,:4],4).shape==(2,8);print(stable({'selftest':'passed','parameters':params(c),'hosted':params(PRESET['hosted']),'large':params(PRESET['large']),'huge':params(PRESET['huge'])}))
def main():
 p=argparse.ArgumentParser();p.add_argument('--selftest',action='store_true');p.add_argument('--repo',default='.');p.add_argument('--output',default='native-hydra-output');p.add_argument('--preset',choices=PRESET,default='hosted');p.add_argument('--seq',type=int,default=256);p.add_argument('--batch',type=int,default=2);p.add_argument('--eval-batch',type=int,default=2);p.add_argument('--accum',type=int,default=4);p.add_argument('--epochs',type=int,default=8);p.add_argument('--max-steps',type=int,default=2500);p.add_argument('--learning-rate',type=float,default=3e-4);p.add_argument('--eval-every',type=int,default=50);p.add_argument('--eval-batches',type=int,default=4);p.add_argument('--checkpoint-every',type=int,default=50);p.add_argument('--log-every',type=int,default=5);p.add_argument('--sample',type=int,default=256);p.add_argument('--minutes',type=int,default=320);p.add_argument('--threads',type=int,default=max(1,min(4,os.cpu_count() or 2)));p.add_argument('--seed',type=int,default=3407);p.add_argument('--max-file-bytes',type=int,default=786432);p.add_argument('--resume',action='store_true');a=p.parse_args();selftest() if a.selftest else train(a)
if __name__=='__main__':main()
