#!/usr/bin/env python3
from __future__ import annotations
import argparse, base64, hashlib, json, random
from pathlib import Path
CLASSES=['document','chat','receipt','calendar','error','notes']
SEED=20260719
SIDE=8
D=SIDE*SIDE

def clamp(x): return max(-1.0,min(1.0,x))
def blank(v): return [v]*D
def idx(x,y): return y*SIDE+x

def draw(kind,rng):
    light=rng.uniform(.65,.96); dark=rng.uniform(-.95,-.45); mid=rng.uniform(-.2,.35)
    a=blank(light)
    sx=rng.choice([-1,0,0,0,1]); sy=rng.choice([-1,0,0,0,1])
    def pix(x,y,v):
        x+=sx;y+=sy
        if 0<=x<SIDE and 0<=y<SIDE:a[idx(x,y)]=v
    def rect(x0,y0,x1,y1,v):
        for y in range(y0,y1):
            for x in range(x0,x1):pix(x,y,v)
    def line(y,x0,x1,v):
        for x in range(x0,x1):pix(x,y,v)
    if kind=='document':
        rect(1,0,7,8,light); line(1,2,6,dark)
        for y,w in [(3,5),(4,4),(5,5),(7,5)]:line(y,1,1+w,dark)
        rect(1,6,7,7,mid)
    elif kind=='chat':
        rect(0,0,8,1,mid)
        rect(0,2,4,3,dark);rect(4,3,8,4,mid);rect(0,5,5,6,dark);rect(5,6,8,7,mid)
    elif kind=='receipt':
        a=blank(mid);rect(2,0,6,8,light);line(1,3,5,dark)
        for y in [3,4,6,7]:line(y,2,6,dark)
    elif kind=='calendar':
        for y in [0,2,4,6]:line(y,0,8,dark)
        for x in [0,2,4,6]:
            for y in range(8):pix(x,y,dark)
        rect(3,1,4,2,mid);rect(5,5,6,6,mid)
    elif kind=='error':
        a=blank(dark);rect(0,0,8,1,mid)
        for y,w in [(2,5),(3,3),(4,6),(5,4)]:line(y,1,1+w,light)
        rect(0,7,8,8,-.15)
    else:
        a=blank(mid);rect(1,1,5,3,light);rect(4,0,7,2,dark);rect(0,4,4,7,light);rect(4,4,8,8,dark)
        line(2,2,4,mid);line(5,1,3,dark);line(6,5,7,light)
    noise=rng.uniform(.015,.08)
    return [clamp(v+rng.uniform(-noise,noise)) for v in a]

def split(n,offset):
    x=[];y=[]
    for ci,c in enumerate(CLASSES):
        for i in range(n):
            rng=random.Random(SEED+offset+ci*100000+i)
            x.append(draw(c,rng)+[1.0]);y.append(ci)
    order=list(range(len(x)));random.Random(SEED+offset+99).shuffle(order)
    return [x[i] for i in order],[y[i] for i in order]

def scores(w,x):return [sum(a*b for a,b in zip(row,x)) for row in w]
def predict(w,x):
    s=scores(w,x);return max(range(len(s)),key=s.__getitem__)
def accuracy(w,x,y):return sum(predict(w,a)==b for a,b in zip(x,y))/len(y)
def matrix(w,x,y):
    m=[[0]*len(CLASSES) for _ in CLASSES]
    for a,b in zip(x,y):m[b][predict(w,a)]+=1
    return m

def quantize(w):
    scales=[];q=[]
    for row in w:
        scale=max(max(abs(v) for v in row)/127,1e-8);scales.append(scale)
        q.extend(max(-127,min(127,round(v/scale))) for v in row)
    raw=bytes((v+256)%256 for v in q)
    return base64.b64encode(raw).decode(),scales

def qweights(model):
    raw=base64.b64decode(model['weights_base64']);vals=[b if b<128 else b-256 for b in raw]
    out=[];p=0
    for scale in model['scales']:
        out.append([vals[p+i]*scale for i in range(model['input_dim'])]);p+=model['input_dim']
    return out

def canonical(obj):return json.dumps(obj,separators=(',',':'),sort_keys=True)

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--output',type=Path,default=Path('archie'));args=ap.parse_args()
    train_x,train_y=split(420,0);hold_x,hold_y=split(110,50_000_000)
    w=[[0.0]*(D+1) for _ in CLASSES];initial=hashlib.sha256(canonical(w).encode()).hexdigest();curve=[];steps=0
    rng=random.Random(SEED)
    for epoch in range(24):
        order=list(range(len(train_y)));rng.shuffle(order);mistakes=0;rate=.18/(1+epoch*.04)
        for i in order:
            x=train_x[i];truth=train_y[i];guess=predict(w,x);steps+=1
            if guess!=truth:
                mistakes+=1
                for j,v in enumerate(x):w[truth][j]+=rate*v;w[guess][j]-=rate*v
        curve.append({'epoch':epoch+1,'mistake_rate':round(mistakes/len(order),6),'holdout_accuracy':round(accuracy(w,hold_x,hold_y),6)})
    encoded,scales=quantize(w)
    model={'schema':'archie-screenshot-perceptron/v1','model_id':'archie-surface-perceptron-int8-v1','purpose':'classify six coarse screenshot layouts; not OCR or general vision','classes':CLASSES,'side':SIDE,'input_dim':D+1,'weights_base64':encoded,'scales':scales,'confidence_threshold':.55}
    qw=qweights(model);qacc=accuracy(qw,hold_x,hold_y);final=hashlib.sha256(canonical(w).encode()).hexdigest();model_text=canonical(model);digest=hashlib.sha256(model_text.encode()).hexdigest()
    receipt={'schema':'archie-screenshot-training-receipt/v1','promotion':'admitted','admitted_for':'six coarse screenshot-layout classes only','boundaries':['no OCR','no object recognition','no arbitrary-photo understanding','response generation remains deterministic'],'training':{'seed':SEED,'examples':len(train_y),'holdout_examples':len(hold_y),'epochs':24,'optimizer_steps':steps,'parameters':len(CLASSES)*(D+1),'changed_tensors':initial!=final,'initial_tensors_sha256':initial,'final_tensors_sha256':final},'evaluation':{'float_accuracy':accuracy(w,hold_x,hold_y),'quantized_accuracy':qacc,'confusion_matrix':matrix(qw,hold_x,hold_y),'classes':CLASSES,'curve':curve},'model_sha256':digest}
    assert receipt['training']['changed_tensors'] and qacc>=.98
    args.output.mkdir(parents=True,exist_ok=True)
    (args.output/'surface-model.json').write_text(model_text)
    (args.output/'surface-admission.json').write_text(json.dumps(receipt,indent=2,sort_keys=True)+'\n')
    print(json.dumps({'model_sha256':digest,'metrics':receipt['training']|{'quantized_accuracy':qacc},'promotion':'admitted'},indent=2))
if __name__=='__main__':main()
