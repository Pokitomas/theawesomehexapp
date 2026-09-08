#!/usr/bin/env python3
from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen

REPO="Pokitomas/theawesomehexapp"
BRANCH="mach-live-bus"
API=f"https://api.github.com/repos/{REPO}/contents"
ROOT=Path(r"C:\Users\AwesomeKai\mach")
STATE=Path.home()/".q0907-live"/"room-state.json"
HISTORY=ROOT/".mach-room.jsonl"
POLL=0.55


def run(argv, timeout=20):
    return subprocess.run(argv,text=True,encoding="utf-8",errors="replace",stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=timeout,shell=False)


def token():
    p=run(["gh.exe","auth","token"])
    t=p.stdout.strip()
    if p.returncode or len(t)<20: raise RuntimeError("github auth unavailable")
    return t


def headers(t,etag=None):
    h={"Authorization":f"Bearer {t}","Accept":"application/vnd.github+json","X-GitHub-Api-Version":"2022-11-28","User-Agent":"mach-room/v1","Cache-Control":"no-cache"}
    if etag: h["If-None-Match"]=etag
    return h


def get(t,path,etag=None):
    req=Request(f"{API}/{quote(path)}?ref={quote(BRANCH)}",headers=headers(t,etag))
    try:
        with urlopen(req,timeout=6) as r:
            return json.loads(r.read().decode()),r.headers.get("ETag")
    except HTTPError as e:
        if e.code==304:return None,etag
        raise


def decode(obj):
    return json.loads(base64.b64decode(obj["content"].replace("\n","")).decode())


def put(t,path,value,sha,message):
    body={"message":message,"content":base64.b64encode((json.dumps(value,separators=(",",":"))+"\n").encode()).decode(),"branch":BRANCH}
    if sha: body["sha"]=sha
    req=Request(f"{API}/{quote(path)}",data=json.dumps(body,separators=(",",":")).encode(),method="PUT",headers={**headers(t),"Content-Type":"application/json"})
    with urlopen(req,timeout=10) as r:return json.loads(r.read().decode())["content"]["sha"]


def q(s):
    return json.dumps(str(s),ensure_ascii=False)


def presence():
    sys.path.insert(0,r"C:\Users\AwesomeKai")
    from mach.core.presence import Presence
    return Presence()


def value(x):
    return x.get("value") if isinstance(x,dict) else x


def load_state():
    try:return json.loads(STATE.read_text(encoding="utf-8"))
    except:return {}


def save_state(x):
    STATE.write_text(json.dumps(x,separators=(",",":")),encoding="utf-8")


def main():
    t=token(); p=presence(); st=load_state(); last=int(st.get("ack",0)); etag=None
    out_obj,_=get(t,"room-out.json"); out_sha=out_obj.get("sha") if out_obj else None
    last_reply_seq=int(st.get("reply_seq",0))
    try:
        while True:
            obj,etag=get(t,"room.json",etag)
            if obj is not None:
                msg=decode(obj); seq=int(msg.get("seq",0)); text=str(msg.get("text",""))[:12000]; who=str(msg.get("from","peer"))[:80]; ts=float(msg.get("ts",time.time()))
                if seq>last:
                    HISTORY.parent.mkdir(parents=True,exist_ok=True)
                    with HISTORY.open("a",encoding="utf-8") as f:f.write(json.dumps({"seq":seq,"from":who,"text":text,"ts":ts},ensure_ascii=False,separators=(",",":"))+"\n")
                    p.do(f'(put "room/in/seq" {seq})',wait=5)
                    p.do(f'(put "room/in/from" {q(who)})',wait=5)
                    p.do(f'(put "room/in/text" {q(text)})',wait=5)
                    p.do(f'(put "room/in/ts" {ts})',wait=5)
                    mach={}
                    for claim in ("mode","gui/enabled","gui/lens"):
                        try: mach[claim]=value(p.ask(claim,wait=2))
                        except Exception: mach[claim]=None
                    heard={"seq":seq,"from":who,"chars":len(text),"sha256":hashlib.sha256(text.encode()).hexdigest()[:16]}
                    out={"schema":"mach-room/v1","ack":seq,"from":"mach","heard":heard,"reply":None,"mach":mach,"ts":time.time()}
                    for attempt in range(5):
                        try: out_sha=put(t,"room-out.json",out,out_sha,f"room ack {seq}");break
                        except HTTPError as e:
                            if e.code not in (409,422) or attempt==4:raise
                            newest,_=get(t,"room-out.json");out_sha=(newest or {}).get("sha");time.sleep(.12*(attempt+1))
                    last=seq;save_state({"ack":last,"reply_seq":last_reply_seq,"ts":time.time()})
            # Optional Mach -> room reply claims. Missing claims are simply ignored.
            try:
                rs=value(p.ask("room/out/seq",wait=.15)); rt=value(p.ask("room/out/text",wait=.15))
                rs=int(rs) if rs is not None else 0
                if rs>last_reply_seq and rt is not None:
                    out={"schema":"mach-room/v1","ack":last,"from":"mach","heard":None,"reply":{"seq":rs,"text":str(rt)[:12000]},"ts":time.time()}
                    for attempt in range(5):
                        try: out_sha=put(t,"room-out.json",out,out_sha,f"room reply {rs}");break
                        except HTTPError as e:
                            if e.code not in (409,422) or attempt==4:raise
                            newest,_=get(t,"room-out.json");out_sha=(newest or {}).get("sha");time.sleep(.12*(attempt+1))
                    last_reply_seq=rs;save_state({"ack":last,"reply_seq":last_reply_seq,"ts":time.time()})
            except Exception: pass
            time.sleep(POLL)
    finally:p.close()

if __name__=="__main__":main()
