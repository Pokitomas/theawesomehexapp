#!/usr/bin/env python3
from __future__ import annotations
import argparse,gzip,hashlib,html,json,re,time,urllib.parse,urllib.request
from io import BytesIO
from pathlib import Path
from PIL import Image,ImageOps

UA='saturation-general-corpus/1.0'
IMAGE_EXT=('jpg','jpeg','png','webp','gif','avif')

def read(path:str):
    with gzip.open(path,'rt',encoding='utf-8') as f: return [json.loads(line) for line in f if line.strip()]

def fetch_bytes(url:str,max_bytes:int=14_000_000,timeout:int=25):
    request=urllib.request.Request(url,headers={'User-Agent':UA,'Accept':'image/avif,image/webp,image/*,*/*;q=0.5'})
    with urllib.request.urlopen(request,timeout=timeout) as response:
        ctype=(response.headers.get('Content-Type') or '').lower()
        if 'image/' not in ctype: raise ValueError(f'not image: {ctype}')
        length=int(response.headers.get('Content-Length') or 0)
        if length and length>max_bytes: raise ValueError('image too large')
        data=response.read(max_bytes+1)
        if len(data)>max_bytes: raise ValueError('image too large')
        return data

def fetch_html(url:str,max_bytes:int=900_000):
    request=urllib.request.Request(url,headers={'User-Agent':UA,'Accept':'text/html,application/xhtml+xml'})
    with urllib.request.urlopen(request,timeout=20) as response:
        ctype=(response.headers.get('Content-Type') or '').lower()
        if 'html' not in ctype: return ''
        return response.read(max_bytes).decode(response.headers.get_content_charset() or 'utf-8','replace')

def og_image(url:str):
    try: text=fetch_html(url)
    except Exception: return ''
    patterns=[
        r'<meta[^>]+(?:property|name)=["\']og:image(?::secure_url)?["\'][^>]+content=["\']([^"\']+)',
        r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+(?:property|name)=["\']og:image(?::secure_url)?["\']',
        r'<meta[^>]+(?:property|name)=["\']twitter:image(?::src)?["\'][^>]+content=["\']([^"\']+)',
        r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+(?:property|name)=["\']twitter:image(?::src)?["\']'
    ]
    for pattern in patterns:
        match=re.search(pattern,text,flags=re.I)
        if match:
            return urllib.parse.urljoin(url,html.unescape(match.group(1).strip()))
    return ''

def save_variants(data:bytes,key:str,out_dir:Path):
    image=Image.open(BytesIO(data)); image.seek(0); image=ImageOps.exif_transpose(image)
    if image.mode not in ('RGB','RGBA'): image=image.convert('RGBA' if 'transparency' in image.info else 'RGB')
    if image.mode=='RGBA':
        background=Image.new('RGB',image.size,(245,244,239)); background.paste(image,mask=image.getchannel('A')); image=background
    else: image=image.convert('RGB')
    original_size=image.size
    def variant(name,max_size,quality):
        copy=image.copy(); copy.thumbnail(max_size,Image.Resampling.LANCZOS)
        path=out_dir/f'{key}-{name}.webp'; copy.save(path,'WEBP',quality=quality,method=6)
        return path,copy.size
    card,card_size=variant('card',(1280,900),76)
    full,full_size=variant('full',(2200,1800),84)
    return {'card':f'media/{card.name}','full':f'media/{full.name}','width':full_size[0],'height':full_size[1],'original_width':original_size[0],'original_height':original_size[1]}

def dedupe_sources(record):
    seen=set(); out=[]
    for source in record.get('sources') or []:
        url=(source.get('url') or '').strip()
        if not url or url in seen: continue
        seen.add(url); out.append(source)
    record['sources']=out

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--input',default='corpus/general.jsonl.gz')
    parser.add_argument('--output',default='corpus/general-media.jsonl.gz')
    parser.add_argument('--media-dir',default='corpus/media')
    parser.add_argument('--max-media',type=int,default=900)
    parser.add_argument('--discover-forum',type=int,default=450)
    args=parser.parse_args()
    rows=read(args.input); out_dir=Path(args.media_dir); out_dir.mkdir(parents=True,exist_ok=True)
    discovered=0
    for record in rows:
        if record.get('type')=='forum' and not record.get('media') and record.get('outbound_url') and discovered<args.discover_forum:
            image=og_image(record['outbound_url']); discovered+=1
            if image:
                record['media']=[{'kind':'image','original':image,'preview':image,'alt':record.get('title',''),'source_url':record['outbound_url']}]
                record.setdefault('sources',[]).append({'label':'outbound page image','url':image,'kind':'media'})
            time.sleep(.025)
    quotas={kind:max(1,args.max_media//3) for kind in ('article','forum','social')}; used={k:0 for k in quotas}; cache={}; success=0
    # Engagement and recency determine which real records get mirrored first, while every record retains original URLs.
    rows.sort(key=lambda r:(r.get('type',''),-sum(int(v or 0) for v in (r.get('engagement') or {}).values()),r.get('published_at','')),reverse=False)
    for record in rows:
        kind=record.get('type')
        media=record.get('media') or []
        if not media: dedupe_sources(record); continue
        first=media[0]; remote=first.get('original') or first.get('preview')
        if not remote or used.get(kind,0)>=quotas.get(kind,0): dedupe_sources(record); continue
        key=hashlib.sha256(remote.encode()).hexdigest()[:24]
        try:
            if key not in cache: cache[key]=save_variants(fetch_bytes(remote),key,out_dir)
            local=cache[key]; first.update(local); first['aspect']=round(local['width']/max(1,local['height']),4)
            used[kind]+=1; success+=1
        except Exception:
            pass
        dedupe_sources(record)
    # Restore deterministic type/date order for build stability.
    rows.sort(key=lambda r:(r.get('type',''),r.get('published_at',''),str(r.get('native_id',''))))
    path=Path(args.output); path.parent.mkdir(parents=True,exist_ok=True)
    with gzip.open(path,'wt',encoding='utf-8',compresslevel=6) as out:
        for record in rows: out.write(json.dumps(record,ensure_ascii=False,separators=(',',':'))+'\n')
    print(f'compressed {success} images; per type {used}; discovered {discovered} forum pages')

if __name__=='__main__': main()
