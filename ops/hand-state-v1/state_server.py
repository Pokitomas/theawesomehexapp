#!/usr/bin/env python3
import json,os,secrets,time
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse
B=Path('/mnt/c/Users/AwesomeKai/AppData/Local/Temp')
STATE=B/'ARCHIE_LIVE_STATE.json';SCREEN=B/'archie_phone_screen.jpg';HTML=B/'ARCHIE_STATE_PHONE.html';REQ=B/'ARCHIE_STATE_ACTION_REQ.json';RESP=B/'ARCHIE_STATE_ACTION_RESP.json'
SAFE={'look','take','play','save','undo','redo','esc','fit','edit','cut','tap'}
def atomic_req(v):
 t=REQ.with_suffix('.next.json');t.write_text(json.dumps(v,separators=(',',':')),encoding='utf-8');os.replace(t,REQ)
def dispatch(d,timeout=.8):
 rid=secrets.token_hex(8);q={'id':rid,'at':time.time(),'action':d['action']}
 if d['action']=='tap':q.update(x=float(d.get('x',0)),y=float(d.get('y',0)))
 atomic_req(q);started=time.perf_counter();deadline=started+timeout
 while time.perf_counter()<deadline:
  try:
   r=json.loads(RESP.read_text(encoding='utf-8'))
   if r.get('id')==rid:
    r['roundtrip_ms']=round((time.perf_counter()-started)*1000,1);return r
  except Exception:pass
  time.sleep(.004)
 return {'ok':False,'action':d['action'],'error':'resident actuator timeout','roundtrip_ms':round((time.perf_counter()-started)*1000,1)}
class H(BaseHTTPRequestHandler):
 server_version='HAND-State/2'
 def log_message(self,*a):pass
 def cors(self):
  self.send_header('Access-Control-Allow-Origin','*');self.send_header('Access-Control-Allow-Headers','content-type');self.send_header('Access-Control-Allow-Methods','GET,POST,OPTIONS');self.send_header('Cache-Control','no-store')
 def sendb(self,code,b,ct):
  self.send_response(code);self.cors();self.send_header('Content-Type',ct);self.send_header('Content-Length',str(len(b)));self.end_headers();self.wfile.write(b)
 def do_OPTIONS(self):self.send_response(204);self.cors();self.end_headers()
 def do_GET(self):
  p=urlparse(self.path).path
  if p=='/':
   try:return self.sendb(200,HTML.read_bytes(),'text/html; charset=utf-8')
   except Exception as e:return self.sendb(500,str(e).encode(),'text/plain')
  if p=='/ping':return self.sendb(200,json.dumps({'ok':True,'at':time.time()}).encode(),'application/json')
  if p=='/state':
   try:return self.sendb(200,STATE.read_bytes(),'application/json')
   except Exception as e:return self.sendb(503,json.dumps({'ok':False,'error':str(e)}).encode(),'application/json')
  if p=='/screen':
   try:return self.sendb(200,SCREEN.read_bytes(),'image/jpeg')
   except Exception as e:return self.sendb(503,str(e).encode(),'text/plain')
  if p=='/events':
   self.send_response(200);self.cors();self.send_header('Content-Type','text/event-stream');self.send_header('Connection','keep-alive');self.end_headers();last=0
   try:
    while True:
     try:m=STATE.stat().st_mtime_ns
     except:m=0
     if m!=last and m:
      last=m;self.wfile.write(('data: '+STATE.read_text(encoding='utf-8')+'\n\n').encode());self.wfile.flush()
     time.sleep(.05)
   except (BrokenPipeError,ConnectionResetError):pass
   return
  self.sendb(404,b'not found','text/plain')
 def do_POST(self):
  if urlparse(self.path).path!='/action':return self.sendb(404,b'not found','text/plain')
  try:
   n=min(int(self.headers.get('content-length','0')),65536);d=json.loads(self.rfile.read(n) or b'{}');a=str(d.get('action','')).lower()
   if a not in SAFE:raise ValueError('unknown action')
   d['action']=a;r=dispatch(d);self.sendb(200 if r.get('ok') else 409,json.dumps(r).encode(),'application/json')
  except Exception as e:self.sendb(400,json.dumps({'ok':False,'error':str(e)}).encode(),'application/json')
ThreadingHTTPServer(('127.0.0.1',8796),H).serve_forever()
