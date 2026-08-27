from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
from pathlib import Path
from typing import Any, Iterable

from core import canonical, receipt

SCHEMA="archie-study-index/v1"


def connect(path:Path,*,readonly:bool=False)->sqlite3.Connection:
    if readonly:
        con=sqlite3.connect(f"file:{path.as_posix()}?mode=ro",uri=True)
    else:
        path.parent.mkdir(parents=True,exist_ok=True); con=sqlite3.connect(path)
    con.row_factory=sqlite3.Row; return con


def init(path:Path)->dict[str,Any]:
    con=connect(path)
    try:
        con.executescript("""
        PRAGMA journal_mode=WAL;
        PRAGMA synchronous=NORMAL;
        CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS docs(id TEXT PRIMARY KEY,source TEXT NOT NULL,license TEXT NOT NULL,kind TEXT NOT NULL,split TEXT NOT NULL,text_sha256 TEXT NOT NULL,text TEXT NOT NULL);
        CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(id UNINDEXED,source,kind,text,content='docs',content_rowid='rowid',tokenize='unicode61');
        CREATE TRIGGER IF NOT EXISTS docs_ai AFTER INSERT ON docs BEGIN INSERT INTO docs_fts(rowid,id,source,kind,text) VALUES(new.rowid,new.id,new.source,new.kind,new.text); END;
        CREATE TRIGGER IF NOT EXISTS docs_ad AFTER DELETE ON docs BEGIN INSERT INTO docs_fts(docs_fts,rowid,id,source,kind,text) VALUES('delete',old.rowid,old.id,old.source,old.kind,old.text); END;
        CREATE TRIGGER IF NOT EXISTS docs_au AFTER UPDATE ON docs BEGIN INSERT INTO docs_fts(docs_fts,rowid,id,source,kind,text) VALUES('delete',old.rowid,old.id,old.source,old.kind,old.text); INSERT INTO docs_fts(rowid,id,source,kind,text) VALUES(new.rowid,new.id,new.source,new.kind,new.text); END;
        """)
        con.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('schema',?)",(SCHEMA,)); con.commit()
        return {"path":str(path),"fts5":True}
    finally: con.close()


def ingest_jsonl(path:Path,shards:Iterable[Path],*,allowed_splits:set[str]|None=None)->dict[str,Any]:
    init(path); con=connect(path); inserted=0; skipped=0; allowed=allowed_splits or {"train","validation"}
    try:
        con.execute("BEGIN")
        for shard in shards:
            split=shard.name.split('-',1)[0]
            if split not in allowed: skipped+=1; continue
            with shard.open("r",encoding="utf-8") as f:
                for line in f:
                    if not line.strip(): continue
                    try: row=json.loads(line); text=str(row["text"]); docid=str(row["id"]); source=str(row.get("source") or ""); lic=str(row.get("license") or ""); kind=str(row.get("kind") or "")
                    except Exception: skipped+=1; continue
                    h=hashlib.sha256(text.encode()).hexdigest()
                    con.execute("INSERT OR IGNORE INTO docs(id,source,license,kind,split,text_sha256,text) VALUES(?,?,?,?,?,?,?)",(docid,source,lic,kind,split,h,text)); inserted+=con.execute("SELECT changes()").fetchone()[0]
        con.commit(); total=con.execute("SELECT count(*) FROM docs").fetchone()[0]
        return {"inserted":inserted,"skipped":skipped,"total":total}
    finally: con.close()


def search(path:Path,query:str,*,limit:int=8,max_chars:int=6000)->dict[str,Any]:
    q=" ".join(x for x in query.replace('"',' ').split() if x)[:500]
    if not q: return {"query":query,"results":[]}
    con=connect(path,readonly=True)
    try:
        rows=con.execute("SELECT d.id,d.source,d.license,d.kind,bm25(docs_fts) score,snippet(docs_fts,3,'[',']',' … ',24) snippet FROM docs_fts JOIN docs d ON d.rowid=docs_fts.rowid WHERE docs_fts MATCH ? ORDER BY score LIMIT ?",(q,max(1,min(50,int(limit))))).fetchall()
        results=[]; used=0
        for r in rows:
            item={k:r[k] for k in r.keys()}; snippet=str(item.get("snippet") or "")
            if used+len(snippet)>max_chars: snippet=snippet[:max(0,max_chars-used)]
            item["snippet"]=snippet; used+=len(snippet); results.append(item)
            if used>=max_chars: break
        return {"query":query,"results":results}
    finally: con.close()


def stats(path:Path)->dict[str,Any]:
    con=connect(path,readonly=True)
    try:
        total=con.execute("SELECT count(*) FROM docs").fetchone()[0]; by_kind=dict(con.execute("SELECT kind,count(*) FROM docs GROUP BY kind ORDER BY count(*) DESC").fetchall()); by_license=dict(con.execute("SELECT license,count(*) FROM docs GROUP BY license ORDER BY count(*) DESC").fetchall())
        body={"schema":SCHEMA,"documents":total,"by_kind":by_kind,"by_license":by_license}; body["sha256"]=hashlib.sha256(canonical(body)).hexdigest(); return body
    finally: con.close()


def court()->dict[str,Any]:
    import tempfile
    with tempfile.TemporaryDirectory(prefix="archie-study-") as td:
        root=Path(td); db=root/"study.db"; shard=root/"train-00000.jsonl"; rows=[{"id":"a","source":"game/a","license":"MIT","kind":"js","text":"voxel raycast block collision terrain"},{"id":"b","source":"web/b","license":"MIT","kind":"ts","text":"rest api form validation dashboard"}]; shard.write_text("".join(json.dumps(x)+"\n" for x in rows),encoding="utf-8"); ing=ingest_jsonl(db,[shard]); a=search(db,"voxel collision"); b=search(db,"voxel collision"); st=stats(db); return receipt("study_index.court",{"passes":ing["total"]==2 and a==b and a["results"] and a["results"][0]["id"]=="a" and st["documents"]==2,"deterministic_search":a==b,"documents":st["documents"],"sha256":st["sha256"]})


def main()->int:
    ap=argparse.ArgumentParser(); sub=ap.add_subparsers(dest="cmd",required=True); bi=sub.add_parser("build"); bi.add_argument("--db",type=Path,required=True); bi.add_argument("shards",nargs="+",type=Path); se=sub.add_parser("search"); se.add_argument("--db",type=Path,required=True); se.add_argument("query"); se.add_argument("--limit",type=int,default=8); ns=ap.parse_args(); v=ingest_jsonl(ns.db,ns.shards) if ns.cmd=="build" else search(ns.db,ns.query,limit=ns.limit); print(json.dumps(v,indent=2)); return 0
if __name__=="__main__": raise SystemExit(main())
