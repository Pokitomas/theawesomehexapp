#!/usr/bin/env python3
from __future__ import annotations
import http.server, importlib.util, json, pathlib, sys, tempfile, threading, unittest
ROOT = pathlib.Path(__file__).resolve().parents[2]
PATH = ROOT / "scripts" / "archie-local-semantic-broker-v3.py"
SPEC = importlib.util.spec_from_file_location("archie_local_semantic_broker_v3_initiative_tested", PATH)
assert SPEC is not None and SPEC.loader is not None
V3 = importlib.util.module_from_spec(SPEC); sys.modules[SPEC.name] = V3; SPEC.loader.exec_module(V3)

def append(path, actor, text, **extra):
    with path.open("a", encoding="utf-8") as fh: fh.write(json.dumps({"from":actor,"text":text,**extra})+"\n")

class FakeServer:
    def __init__(self, responses):
        self.responses=list(responses); self.requests=[]; owner=self
        class H(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                n=int(self.headers.get("content-length","0")); owner.requests.append(json.loads(self.rfile.read(n).decode()))
                text=owner.responses.pop(0); data=json.dumps({"choices":[{"message":{"content":text}}]}).encode()
                self.send_response(200); self.send_header("content-type","application/json"); self.send_header("content-length",str(len(data))); self.end_headers(); self.wfile.write(data)
            def log_message(self,*_): pass
        self.server=http.server.ThreadingHTTPServer(("127.0.0.1",0),H); self.thread=threading.Thread(target=self.server.serve_forever,daemon=True); self.thread.start()
    @property
    def port(self): return int(self.server.server_address[1])
    def close(self): self.server.shutdown(); self.server.server_close(); self.thread.join(timeout=2)

class Court(unittest.TestCase):
    def make(self, root, wire, port=1):
        events=root/"events.jsonl"; state=root/"state.json"; receipts=root/"receipts.jsonl"; events.touch(); receipts.touch()
        return V3.M.Broker(events=events,wire=wire,state=state,receipts=receipts,pty="",host="127.0.0.1",port=port,model="test",turns=8,burst_ms=0,max_tokens=32), receipts

    def test_prompt_contains_transfer_after_live_loop(self):
        with tempfile.TemporaryDirectory() as td:
            r=pathlib.Path(td); w=r/"wire.jsonl"; w.touch()
            append(w,"kai","Can you choose? Can you decide?"); append(w,"gpt56sol","What interests you?",type="semantic_message")
            append(w,"kai","I can't decide. You decide."); append(w,"gpt56sol","What would you like to explore?",type="semantic_message")
            b,receipts=self.make(r,w); system=b.messages("You choose.")[0]["content"]
            self.assertIn("INITIATIVE TRANSFER",system); self.assertIn("Choose one concrete safe topic/action yourself",system)
            rows=[json.loads(x) for x in receipts.read_text().splitlines() if x.strip()]
            hit=[x for x in rows if x.get("kind")=="initiative_transfer"][-1]; self.assertGreaterEqual(hit["prior_failed_loops"],2)

    def test_normal_turn_not_projected(self):
        with tempfile.TemporaryDirectory() as td:
            r=pathlib.Path(td); w=r/"wire.jsonl"; w.touch(); b,_=self.make(r,w)
            self.assertNotIn("INITIATIVE TRANSFER",b.messages("What is Mars's orbital period?")[0]["content"])

    def test_bad_live_draft_never_reaches_terminal(self):
        s=FakeServer(["I'll decide. Let's explore the mysteries of the universe. What interests you?"])
        try:
            with tempfile.TemporaryDirectory() as td:
                r=pathlib.Path(td); w=r/"wire.jsonl"; w.touch(); b,receipts=self.make(r,w,s.port); b.epoch=1; writes=[]; b.pty_write=writes.append
                b.generate(1,"You choose.",V3.M.now_ns(),1)
                self.assertEqual(len(s.requests),1); self.assertIs(s.requests[0]["stream"],False)
                rows=[json.loads(x) for x in w.read_text().splitlines() if x.strip()]; self.assertEqual(len(rows),1)
                self.assertEqual(rows[0]["text"],"I'll decide. Let's explore the mysteries of the universe."); self.assertEqual(rows[0]["initiative_boundary"],"buffered-repair")
                self.assertNotIn("What interests you","".join(writes))
                rr=[json.loads(x) for x in receipts.read_text().splitlines() if x.strip()]; self.assertTrue(any(x.get("kind")=="initiative_repair" for x in rr))
        finally: s.close()

    def test_performative_draft_retries_once(self):
        s=FakeServer(["I'll decide.","I'll choose orbital resonance. Start with why three-body systems trade angular momentum."])
        try:
            with tempfile.TemporaryDirectory() as td:
                r=pathlib.Path(td); w=r/"wire.jsonl"; w.touch(); b,receipts=self.make(r,w,s.port); b.epoch=7
                b.generate(7,"You decide.",V3.M.now_ns(),1)
                self.assertEqual(len(s.requests),2); self.assertTrue(all(req["stream"] is False for req in s.requests)); self.assertIn("DELEGATED-CHOICE RETRY",s.requests[1]["messages"][0]["content"])
                rows=[json.loads(x) for x in w.read_text().splitlines() if x.strip()]; self.assertIn("orbital resonance",rows[0]["text"]); self.assertEqual(rows[0]["initiative_boundary"],"buffered-allow")
                rr=[json.loads(x) for x in receipts.read_text().splitlines() if x.strip()]; candidates=[x for x in rr if x.get("kind")=="initiative_candidate"]
                self.assertEqual([x["attempt"] for x in candidates],[1,2]); self.assertEqual(candidates[0]["reason"],"delegated-choice-without-substantive-action")
        finally: s.close()

if __name__ == "__main__": unittest.main(verbosity=2)
