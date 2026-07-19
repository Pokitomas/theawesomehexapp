#!/usr/bin/env python3
"""Reproducibly train and admit Archie's narrow local neural task router."""
from __future__ import annotations
import argparse,base64,collections,hashlib,itertools,json,math,random,re,struct,zlib
from pathlib import Path

DATA=json.loads(zlib.decompress(base64.b64decode("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")))
MODES=DATA["modes"];BASE_TRAIN=DATA["base_train"];LEXICON=DATA["lexicon"];HOLDOUT=DATA["holdout"]
FEATURE_DIM=2048;SEED=20260719;EPOCHS=30;MARGIN_THRESHOLD=0.05

def fnv1a(value):
    h=2166136261
    for character in value:
        h^=ord(character);h=(h*16777619)&0xffffffff
    return h

def feature_names(text):
    words=re.sub(r"[^a-z0-9\s]+"," ",text.lower()).split()
    out=["w:"+word for word in words]
    out+=["b:"+words[i]+"_"+words[i+1] for i in range(len(words)-1)]
    compact=" ".join(words);out+=["c:"+compact[i:i+3] for i in range(max(0,len(compact)-2))]
    return out

def vectorize(text):
    counts=collections.Counter(fnv1a(feature)%FEATURE_DIM for feature in feature_names(text))
    values={index:math.log1p(count) for index,count in counts.items()}
    norm=math.sqrt(sum(value*value for value in values.values())) or 1.0
    return {index:value/norm for index,value in values.items()}

def examples():
    result=[];rng=random.Random(42)
    for mode,phrases in BASE_TRAIN.items():
        for phrase in phrases:
            result.append((phrase,mode))
            if rng.random()<0.5:result.append(("archie "+phrase,mode))
            if rng.random()<0.4:result.append((phrase+" please",mode))
    generated=[];rng=random.Random(SEED)
    for mode,values in LEXICON.items():
        combos=list(itertools.product(values["verbs"],values["objects"],values["extras"]));rng.shuffle(combos)
        for verb,subject,extra in combos[:300]:
            forms=[f"{verb} {subject} {extra}",f"archie {verb} {subject} {extra}",f"please {verb} {subject} {extra}"]
            generated.append((rng.choice(forms),mode))
    return generated+result

def score(weights,bias,vector):
    output=bias.copy()
    for index,value in vector.items():
        row=weights[index]
        for class_index in range(len(MODES)):output[class_index]+=row[class_index]*value
    return output

def train(rows):
    weights=[[0.0]*len(MODES) for _ in range(FEATURE_DIM)];bias=[0.0]*len(MODES)
    vectors=[(vectorize(text),MODES.index(mode)) for text,mode in rows]
    order=list(range(len(vectors)));rng=random.Random(SEED)
    for _ in range(EPOCHS):
        rng.shuffle(order)
        for row_index in order:
            vector,expected=vectors[row_index];scores=score(weights,bias,vector)
            predicted=max(range(len(MODES)),key=scores.__getitem__)
            if predicted==expected:continue
            bias[expected]+=0.2;bias[predicted]-=0.2
            for index,value in vector.items():
                weights[index][expected]+=value;weights[index][predicted]-=value
    return weights,bias

def float_digest(weights,bias):
    digest=hashlib.sha256()
    for row in weights:
        for value in row:digest.update(struct.pack("<d",value))
    for value in bias:digest.update(struct.pack("<d",value))
    return digest.hexdigest()

def quantize(weights):
    scales=[]
    for class_index in range(len(MODES)):
        maximum=max(abs(row[class_index]) for row in weights);scales.append(maximum/127.0 if maximum else 1.0)
    packed=bytearray()
    for row in weights:
        for class_index,scale in enumerate(scales):
            packed.append(max(-127,min(127,int(round(row[class_index]/scale))))&0xff)
    return bytes(packed),scales

def quantized_scores(packed,scales,bias,vector):
    output=bias.copy();classes=len(MODES)
    for feature_index,value in vector.items():
        offset=feature_index*classes
        for class_index,scale in enumerate(scales):
            raw=packed[offset+class_index];signed=raw-256 if raw>127 else raw
            output[class_index]+=signed*scale*value
    return output

def evaluate(packed,scales,bias):
    rows=[];correct=admitted_correct=admitted_count=0
    for expected,prompts in HOLDOUT.items():
        for prompt in prompts:
            scores=quantized_scores(packed,scales,bias,vectorize(prompt))
            order=sorted(range(len(MODES)),key=scores.__getitem__);predicted=MODES[order[-1]]
            margin=scores[order[-1]]-scores[order[-2]];admitted=margin>=MARGIN_THRESHOLD;ok=predicted==expected
            correct+=ok;admitted_count+=admitted;admitted_correct+=admitted and ok
            rows.append({"prompt":prompt,"expected":expected,"predicted":predicted,"margin":round(margin,9),"admitted":admitted,"correct":ok})
    total=len(rows)
    return {"holdout_examples":total,"full_accuracy":round(correct/total,6),"admitted_examples":admitted_count,
            "admitted_coverage":round(admitted_count/total,6),"admitted_accuracy":round(admitted_correct/admitted_count,6),"rows":rows}

def canonical(value):return (json.dumps(value,sort_keys=True,separators=(",",":"))+"\n").encode()

def main():
    parser=argparse.ArgumentParser();parser.add_argument("--output-dir",required=True);out=Path(parser.parse_args().output_dir);out.mkdir(parents=True,exist_ok=True)
    rows=examples();initial=[[0.0]*len(MODES) for _ in range(FEATURE_DIM)];initial_bias=[0.0]*len(MODES)
    weights,bias=train(rows);packed,scales=quantize(weights);evaluation=evaluate(packed,scales,bias)
    model={"schema":"archie-local-neural-router/v1","model_id":"archie-router-bytehash-perceptron-v1","classes":MODES,
           "feature_dim":FEATURE_DIM,"hash":"fnv1a-32","features":["word-unigram","word-bigram","character-trigram"],
           "normalization":"log1p-l2","weights_layout":"feature-major-class-minor-int8",
           "weights_base64":base64.b64encode(packed).decode(),"scales":[round(value,12) for value in scales],
           "bias":[round(value,12) for value in bias],"margin_threshold":MARGIN_THRESHOLD,
           "admission_scope":"local-task-mode-routing-only","response_generation":"deterministic"}
    model_bytes=canonical(model);model_sha=hashlib.sha256(model_bytes).hexdigest()
    initial_sha=float_digest(initial,initial_bias);final_sha=float_digest(weights,bias)
    gates={"changed_tensors":initial_sha!=final_sha,"full_accuracy_at_least_0_90":evaluation["full_accuracy"]>=0.90,
           "admitted_accuracy_equals_1_0":evaluation["admitted_accuracy"]==1.0,
           "admitted_coverage_at_least_0_90":evaluation["admitted_coverage"]>=0.90,"model_digest_present":len(model_sha)==64}
    admission={"schema":"archie-local-neural-router-admission/v1","model_id":model["model_id"],"model_sha256":model_sha,
      "training":{"algorithm":"multiclass-perceptron","seed":SEED,"epochs":EPOCHS,"feature_dim":FEATURE_DIM,
      "training_examples":len(rows),"training_examples_sha256":hashlib.sha256(canonical(rows)).hexdigest(),
      "script_sha256":hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),"initial_tensors_sha256":initial_sha,
      "final_tensors_sha256":final_sha,"quantized_weights_sha256":hashlib.sha256(packed).hexdigest(),"changed_tensors":gates["changed_tensors"]},
      "evaluation":{"holdout_sha256":hashlib.sha256(canonical(HOLDOUT)).hexdigest(),**evaluation,"margin_threshold":MARGIN_THRESHOLD},
      "gates":gates,"admission":"admitted","admitted_for":"local task-mode routing only","neural_response_generation":False,
      "fallback":"deterministic routing when model verification fails or margin is below threshold"}
    if not all(gates.values()):raise SystemExit("router admission gates failed")
    (out/"router-model.json").write_bytes(model_bytes);(out/"router-admission.json").write_bytes(canonical(admission))
    print(json.dumps({"model_sha256":model_sha,"training_examples":len(rows),"full_accuracy":evaluation["full_accuracy"],
      "admitted_accuracy":evaluation["admitted_accuracy"],"admitted_coverage":evaluation["admitted_coverage"],
      "changed_tensors":gates["changed_tensors"],"admission":admission["admission"]},sort_keys=True))

if __name__=="__main__":main()
