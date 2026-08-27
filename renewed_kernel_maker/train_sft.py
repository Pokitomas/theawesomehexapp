from __future__ import annotations

import argparse
import hashlib
import json
import os
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from core import canonical, receipt


@dataclass(frozen=True)
class Recipe:
    base_model: str
    train_jsonl: str
    output_dir: str
    max_seq_length: int = 1024
    lora_r: int = 16
    lora_alpha: int = 32
    learning_rate: float = 2e-4
    epochs: float = 1.0
    gradient_accumulation: int = 16
    batch_size: int = 1
    quantization: str = "nf4-4bit"
    gradient_checkpointing: bool = True
    target_modules: tuple[str, ...] = ("q_proj","k_proj","v_proj","o_proj","gate_proj","up_proj","down_proj")


def inspect_dataset(path: Path) -> dict[str, Any]:
    count=0; bytes_=0; hashes=[]; bad=0
    if not path.is_file(): return {"exists":False,"records":0,"bytes":0,"bad":0,"sha256":None}
    with path.open("rb") as f:
        for raw in f:
            if not raw.strip(): continue
            bytes_+=len(raw)
            try:
                v=json.loads(raw)
                if not isinstance(v.get("messages"),list): bad+=1; continue
                hashes.append(hashlib.sha256(canonical(v)).hexdigest()); count+=1
            except Exception: bad+=1
    return {"exists":True,"records":count,"bytes":bytes_,"bad":bad,"sha256":hashlib.sha256("\n".join(hashes).encode()).hexdigest()}


def recipe_receipt(recipe: Recipe) -> dict[str, Any]:
    ds=inspect_dataset(Path(recipe.train_jsonl))
    return receipt("sft.recipe",{"recipe":asdict(recipe),"dataset":ds,"admissible":ds["exists"] and ds["records"]>0 and ds["bad"]==0})


def _format_messages(tokenizer, messages: list[dict[str,str]]) -> str:
    if hasattr(tokenizer,"apply_chat_template"):
        return tokenizer.apply_chat_template(messages,tokenize=False,add_generation_prompt=False)
    return "\n".join(f"{m.get('role','user').upper()}: {m.get('content','')}" for m in messages)


def train(recipe: Recipe) -> dict[str, Any]:
    rr=recipe_receipt(recipe)
    if not rr["payload"]["admissible"]:
        return receipt("sft.train",{"status":"BLOCKED","reason":"dataset-not-admissible","recipe":rr["payload"]})
    try:
        import torch
        from datasets import Dataset
        from peft import LoraConfig, get_peft_model
        from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig, Trainer, TrainingArguments
    except Exception as exc:
        return receipt("sft.train",{"status":"BLOCKED","reason":f"training-dependencies:{type(exc).__name__}: {exc}","recipe":rr["payload"]})
    if not torch.cuda.is_available():
        return receipt("sft.train",{"status":"BLOCKED","reason":"cuda-unavailable","recipe":rr["payload"]})
    free,total=torch.cuda.mem_get_info(); free_gib=free/(1024**3); total_gib=total/(1024**3)
    if free_gib < 4.5:
        return receipt("sft.train",{"status":"BLOCKED","reason":"free-vram-below-4.5-gib","free_gib":free_gib,"total_gib":total_gib})
    rows=[]
    for line in Path(recipe.train_jsonl).read_text(encoding="utf-8").splitlines():
        if line.strip(): rows.append(json.loads(line))
    tokenizer=AutoTokenizer.from_pretrained(recipe.base_model,use_fast=True,trust_remote_code=False)
    if tokenizer.pad_token_id is None: tokenizer.pad_token=tokenizer.eos_token
    texts=[_format_messages(tokenizer,r["messages"]) for r in rows]
    def tok(batch):
        z=tokenizer(batch["text"],truncation=True,max_length=recipe.max_seq_length,padding=False)
        z["labels"]=[x[:] for x in z["input_ids"]]; return z
    ds=Dataset.from_dict({"text":texts}).map(tok,batched=True,remove_columns=["text"])
    q=BitsAndBytesConfig(load_in_4bit=True,bnb_4bit_quant_type="nf4",bnb_4bit_compute_dtype=torch.float16,bnb_4bit_use_double_quant=True)
    model=AutoModelForCausalLM.from_pretrained(recipe.base_model,quantization_config=q,device_map="auto",torch_dtype=torch.float16,trust_remote_code=False)
    model.config.use_cache=False
    if recipe.gradient_checkpointing: model.gradient_checkpointing_enable()
    peft=LoraConfig(r=recipe.lora_r,lora_alpha=recipe.lora_alpha,target_modules=list(recipe.target_modules),lora_dropout=.05,bias="none",task_type="CAUSAL_LM")
    model=get_peft_model(model,peft)
    out=Path(recipe.output_dir); out.mkdir(parents=True,exist_ok=True)
    args=TrainingArguments(output_dir=str(out),per_device_train_batch_size=recipe.batch_size,gradient_accumulation_steps=recipe.gradient_accumulation,num_train_epochs=recipe.epochs,learning_rate=recipe.learning_rate,fp16=True,logging_steps=5,save_strategy="epoch",report_to=[],remove_unused_columns=False,optim="paged_adamw_8bit")
    trainer=Trainer(model=model,args=args,train_dataset=ds,data_collator=None)
    before=torch.cuda.max_memory_allocated(); result=trainer.train(); peak=torch.cuda.max_memory_allocated(); trainer.save_model(str(out/"adapter")); tokenizer.save_pretrained(str(out/"adapter"))
    state={"status":"COMPLETE","train_loss":float(result.training_loss),"steps":int(result.global_step),"peak_cuda_gib":peak/(1024**3),"free_start_gib":free_gib,"dataset_sha256":rr["payload"]["dataset"]["sha256"],"base_model":recipe.base_model,"adapter":str(out/"adapter")}
    (out/"training-receipt.json").write_text(json.dumps(receipt("sft.train",state),indent=2),encoding="utf-8")
    return receipt("sft.train",state)


def court()->dict[str,Any]:
    import tempfile
    with tempfile.TemporaryDirectory(prefix="archie-sft-") as td:
        p=Path(td)/"train.jsonl"; row={"messages":[{"role":"user","content":"make app"},{"role":"assistant","content":"{\"tool\":\"finish\",\"args\":{}}"}]}; p.write_text(json.dumps(row)+"\n",encoding="utf-8")
        r=recipe_receipt(Recipe("Qwen/Qwen3-4B",str(p),str(Path(td)/"out")))
        return receipt("sft.court",{"passes":bool(r["payload"]["admissible"]) and r["payload"]["dataset"]["records"]==1,"dataset":r["payload"]["dataset"],"claim":"recipe/data court only; actual training requires CUDA and dependencies"})


def main()->int:
    ap=argparse.ArgumentParser(); ap.add_argument("--base-model",default="Qwen/Qwen3-4B"); ap.add_argument("--train",type=Path,required=True); ap.add_argument("--out",type=Path,required=True); ap.add_argument("--max-seq",type=int,default=1024); ap.add_argument("--epochs",type=float,default=1.0); ap.add_argument("--execute",action="store_true"); ns=ap.parse_args(); recipe=Recipe(ns.base_model,str(ns.train),str(ns.out),max_seq_length=ns.max_seq,epochs=ns.epochs); r=train(recipe) if ns.execute else recipe_receipt(recipe); print(json.dumps(r,indent=2)); return 0 if r["payload"].get("status") in {None,"COMPLETE"} and r["payload"].get("admissible",True) else 2
if __name__=="__main__": raise SystemExit(main())
