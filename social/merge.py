#!/usr/bin/env python3
import argparse,gzip,json,re
from pathlib import Path
TERMS=('tumblr','vine','snapchat','instagram','youtube','soundcloud','spotify','netflix','pokemon','iphone','android','selfie','emoji','meme','streaming','creator','music','film','movie','television','fashion','game','gaming','camera','social media','internet','student','youth')
BRIDGES=[('Why 2016 phone photos feel more alive now','Hard flash, oversaturated camera rolls, low production stakes, and captions that sound like a person rather than a campaign.','phones-and-cameras'),('The social web before every post became a storefront','Personal pages, chronological feeds, fandom blogs, and what people mean when they ask for the internet to feel homemade again.','social-platforms'),('Rebuilding the tiny rituals around discovering music','Shared headphones, SoundCloud repost chains, Tumblr audio posts, lyric screenshots, and playlists made for one specific person.','music-and-audio'),('What people actually miss about Vine','Low production stakes, recurring strangers, remixable jokes, and a format that had not swallowed every other format.','video-and-creators'),('How to host a Pokémon Go summer without pretending it is 2016','Public space, shared objectives, lightweight discovery, and strangers having an obvious reason to speak.','games'),('Can a new social network preserve the awkward post?','Small audiences, visible chronology, low-resolution media, and no obligation to turn every identity fragment into a brand.','social-platforms')]
def read(p):
 out=[]
 with gzip.open(p,'rt',encoding='utf-8') as f:
  for line in f:
   if line.strip():out.append(json.loads(line))
 return out
def score(r):
 if r.get('revival_score') is not None:return float(r['revival_score'])
 text=(' '.join([r.get('title',''),r.get('dek',''),' '.join(r.get('categories',[]))])).lower(); year=int(str(r.get('published','2016'))[:4] or 2016); return min(1,.55*max(0,1-abs(year-2016)/7)+.45*min(1,sum(t in text for t in TERMS)/3))
def bridge(i):
 t,d,c=BRIDGES[i%len(BRIDGES)]; return {'id':2000000000+i,'kind':'bridge','title':t,'published':f'2016-{1+i%12:02d}-{1+i%28:02d}','revision':'generated prototype','contributor':'prototype bridge generator','categories':[c,'2010s-revival'],'dek':d,'body':[d,'Generated prototype bridge connecting an archived 2010s artifact to a present-day revival motive. It is not attributed to a real user.'],'sources':[],'url':'','license':'prototype synthetic','attribution':'saturation auto feed','community':'prototype social layer','score':100+i%900,'comments':i%120,'resurfaced':'2026-07-11','revival_score':.92,'synthetic':True}
def main():
 ap=argparse.ArgumentParser(); ap.add_argument('--articles',default='corpus/wikinews-2019.jsonl.gz'); ap.add_argument('--social',default='corpus/hn-2010s.jsonl.gz'); ap.add_argument('--output',default='corpus/mixed-2010s.jsonl.gz'); ap.add_argument('--bridges',type=int,default=384); a=ap.parse_args(); arts=read(a.articles); soc=read(a.social)
 for r in arts:r['kind']='article';r['resurfaced']='2026-07-11';r['revival_score']=score(r);r['synthetic']=False
 arts.sort(key=lambda r:(-score(r),-int(str(r.get('published','0'))[:4] or 0))); soc.sort(key=lambda r:(-score(r),-int(r.get('score',0))))
 n=min(len(arts),len(soc)+a.bridges); arts=arts[:n]; real=soc[:max(0,n-a.bridges)]; socials=real+[bridge(i) for i in range(n-len(real))]
 rows=arts+socials; p=Path(a.output);p.parent.mkdir(parents=True,exist_ok=True)
 with gzip.open(p,'wt',encoding='utf-8') as f:
  for r in rows:f.write(json.dumps(r,ensure_ascii=False,separators=(',',':'))+'\n')
 Path(str(p)+'.meta.json').write_text(json.dumps({'archiveArticles':len(arts),'socialRecords':len(real),'generatedBridges':len(socials)-len(real),'total':len(rows)},indent=2))
 print(f'mixed {len(arts):,} articles + {len(socials):,} social records')
if __name__=='__main__':main()
