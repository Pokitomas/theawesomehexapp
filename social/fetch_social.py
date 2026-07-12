#!/usr/bin/env python3
import argparse,gzip,html,json,re,time,urllib.parse,urllib.request
from datetime import datetime,timezone
from pathlib import Path
API='https://hn.algolia.com/api/v1/search'
START=int(datetime(2010,1,1,tzinfo=timezone.utc).timestamp()); END=int(datetime(2019,12,31,23,59,59,tzinfo=timezone.utc).timestamp())
MOTIFS=['tumblr','vine','snapchat','instagram','youtube','soundcloud','spotify','netflix','pokemon go','iphone','android','selfie','emoji','meme','streaming','creator','kickstarter','patreon','music','film','fashion','gaming','camera','social media']
def clean(x): return re.sub(r'\s+',' ',re.sub(r'<[^>]+>',' ',html.unescape(x or ''))).strip()
def get(params):
 u=API+'?'+urllib.parse.urlencode(params); req=urllib.request.Request(u,headers={'User-Agent':'saturation-feed-social-corpus/1.0'})
 for n in range(4):
  try:
   with urllib.request.urlopen(req,timeout=45) as r:return json.load(r)
  except Exception:
   if n==3: raise
   time.sleep(n+1)
def pages(query,n,min_points):
 out=[]
 for page in range(n):
  p=get({'query':query,'tags':'story','numericFilters':f'created_at_i>={START},created_at_i<={END},points>={min_points}','hitsPerPage':100,'page':page})
  hits=p.get('hits') or []
  if not hits: break
  out+=hits
  if page+1>=int(p.get('nbPages') or 0): break
  time.sleep(.05)
 return out
def record(h):
 title=clean(h.get('title')); oid=h.get('objectID'); ts=int(h.get('created_at_i') or 0)
 if not title or oid is None or not START<=ts<=END:return None
 date=datetime.fromtimestamp(ts,tz=timezone.utc).date().isoformat(); author=clean(h.get('author')) or 'unknown'; text=clean(h.get('story_text')); url=clean(h.get('url')); points=int(h.get('points') or 0); comments=int(h.get('num_comments') or 0)
 low=f'{title} {text} {url}'.lower(); hits=sum(m in low for m in MOTIFS); year=int(date[:4]); revival=min(1,.45*max(0,1-abs(year-2016)/7)+.45*min(1,hits/3)+.10*min(1,(points+2*comments)/600))
 cats=[m.replace(' ','-') for m in MOTIFS if m in low][:8] or ['2010s-social-web']
 return {'id':int(oid),'kind':'social','title':title,'published':date,'revision':h.get('updated_at') or h.get('created_at') or '','contributor':author,'categories':cats,'dek':(text[:520] if text else f'Hacker News post with {points:,} points and {comments:,} comments.'),'body':([text[:2400]] if text else [])+[f'Public story-level Hacker News record posted by {author}; archived engagement: {points:,} points and {comments:,} comments.']+([f'Original submission linked to {url}.'] if url else []),'sources':([{'title':title,'url':url,'publication':urllib.parse.urlparse(url).hostname or 'linked page','author':author,'date':date}] if url else []),'url':f'https://news.ycombinator.com/item?id={oid}','outbound_url':url,'license':'Public HN metadata; linked content retains original rights','attribution':'Hacker News / original poster','community':'Hacker News','score':points,'comments':comments,'resurfaced':'2026-07-11','revival_score':round(revival,4),'synthetic':False}
def main():
 ap=argparse.ArgumentParser(); ap.add_argument('--output',default='corpus/hn-2010s.jsonl.gz'); ap.add_argument('--max-records',type=int,default=12000); a=ap.parse_args(); raw=pages('',55,35)
 for q in MOTIFS: raw+=pages(q,3,2)
 d={}
 for h in raw:
  r=record(h)
  if r:d[r['id']]=r
 rows=sorted(d.values(),key=lambda r:(-r['revival_score'],-r['score'],r['id']))[:a.max_records]
 if len(rows)<500: raise RuntimeError(f'only {len(rows)} social records')
 p=Path(a.output); p.parent.mkdir(parents=True,exist_ok=True)
 with gzip.open(p,'wt',encoding='utf-8') as f:
  for r in rows:f.write(json.dumps(r,ensure_ascii=False,separators=(',',':'))+'\n')
 print(f'wrote {len(rows):,} social records')
if __name__=='__main__':main()
