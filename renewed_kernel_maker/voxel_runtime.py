from __future__ import annotations

import contextlib
import http.server
import json
import socket
import threading
import time
from pathlib import Path
from typing import Any

from core import receipt

SCHEMA="archie-voxel-runtime/v1"

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self,fmt,*args):pass

def _free_port()->int:
    with socket.socket() as s:s.bind(('127.0.0.1',0));return int(s.getsockname()[1])

def _serve(root:Path):
    port=_free_port()
    def factory(*a,**kw):return Quiet(*a,directory=str(root),**kw)
    httpd=http.server.ThreadingHTTPServer(('127.0.0.1',port),factory);thread=threading.Thread(target=httpd.serve_forever,daemon=True);thread.start();return httpd,port

def execute(root:Path,*,timeout_s:float=20.0)->dict[str,Any]:
    entry=root/'index.html'
    if not entry.is_file():return receipt('voxel.runtime',{'status':'FAIL','reason':'index.html-missing','passes':False})
    try:
        from playwright.sync_api import sync_playwright
    except Exception as exc:
        return receipt('voxel.runtime',{'status':'BLOCKED','reason':f'playwright-unavailable:{type(exc).__name__}','passes':False,'claimable':False})
    httpd,port=_serve(root);errors=[];metrics={};t0=time.perf_counter()
    try:
        with sync_playwright() as p:
            browser=None;launch_errors=[]
            for launcher,kwargs in ((p.chromium,{}),(p.chromium,{'channel':'msedge'}),(p.chromium,{'channel':'chrome'})):
                try:browser=launcher.launch(headless=True,**kwargs);break
                except Exception as exc:launch_errors.append(f'{type(exc).__name__}: {exc}')
            if browser is None:return receipt('voxel.runtime',{'status':'BLOCKED','reason':'browser-launch-failed','details':launch_errors[-3:],'passes':False,'claimable':False})
            page=browser.new_page(viewport={'width':960,'height':540});page.on('pageerror',lambda exc:errors.append(str(exc)));page.on('console',lambda msg:errors.append('console:'+msg.text) if msg.type=='error' else None)
            response=page.goto(f'http://127.0.0.1:{port}/index.html',wait_until='load',timeout=int(timeout_s*1000));page.wait_for_timeout(1500)
            metrics['http_ok']=bool(response and response.ok);metrics['canvas_count']=page.locator('canvas').count();metrics['body_bytes']=len(page.locator('body').inner_html().encode());metrics['raf']=page.evaluate("typeof requestAnimationFrame === 'function'");metrics['storage']=page.evaluate("typeof localStorage !== 'undefined'")
            # Exercise common interaction surfaces without assuming exact IDs.
            page.keyboard.press('KeyW');page.keyboard.press('Space');page.mouse.move(510,280);page.mouse.down(button='left');page.mouse.up(button='left');page.wait_for_timeout(500)
            metrics['alive_after_input']=page.evaluate("document.readyState === 'complete' && document.body != null")
            browser.close()
    except Exception as exc:
        errors.append(f'runner:{type(exc).__name__}: {exc}')
    finally:httpd.shutdown();httpd.server_close()
    elapsed=time.perf_counter()-t0;passes=not errors and metrics.get('http_ok') and metrics.get('canvas_count',0)>=1 and metrics.get('body_bytes',0)>100 and metrics.get('raf') and metrics.get('alive_after_input')
    return receipt('voxel.runtime',{'schema':SCHEMA,'status':'PASS' if passes else 'FAIL','passes':bool(passes),'claimable':bool(passes),'elapsed_s':elapsed,'metrics':metrics,'errors':errors[-20:]})

def court()->dict[str,Any]:
    import tempfile
    with tempfile.TemporaryDirectory(prefix='archie-vr-') as td:
        root=Path(td);root.joinpath('index.html').write_text('<canvas></canvas><script>requestAnimationFrame(()=>{});localStorage.setItem("x","1")</script>',encoding='utf-8');r=execute(root,timeout_s=5);status=r['payload']['status'];return receipt('voxel_runtime.court',{'passes':status in {'PASS','BLOCKED'},'status':status,'rule':'BLOCKED is valid in generic CI, but heldout success requires PASS on the workstation'})
if __name__=='__main__':print(json.dumps(court(),indent=2))
