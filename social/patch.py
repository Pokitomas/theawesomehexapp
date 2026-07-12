#!/usr/bin/env python3
from pathlib import Path

def replace(path, old, new):
    p=Path(path); s=p.read_text()
    if old not in s: raise RuntimeError(f'missing patch anchor in {path}: {old[:80]!r}')
    p.write_text(s.replace(old,new,1))

replace('scripts/build.mjs',
"function sourceLabel(article) {\n  const publication = article.sources?.find(s => s.publication)?.publication?.trim();\n  return (publication || 'Wikinews archive').replace(/\\s+/g,' ').slice(0,90).toUpperCase();\n}",
"function sourceLabel(article) {\n  if (article.kind === 'social') return `HACKER NEWS · ${(article.contributor || 'UNKNOWN').toUpperCase()}`.slice(0,100);\n  if (article.kind === 'bridge') return 'PROTOTYPE REVIVAL BRIDGE';\n  const publication = article.sources?.find(s => s.publication)?.publication?.trim();\n  return (publication || 'Wikinews archive').replace(/\\s+/g,' ').slice(0,90).toUpperCase();\n}")
replace('scripts/build.mjs',
"const archiveInfo = buildArchiveMetadata(archive);",
"const ARTICLE_POOL = archive.map((x,i)=>[x,i]).filter(([x])=>(x.kind||'article')==='article').map(([,i])=>i);\nconst SOCIAL_POOL = archive.map((x,i)=>[x,i]).filter(([x])=>(x.kind||'article')!=='article').map(([,i])=>i);\nif (!ARTICLE_POOL.length || !SOCIAL_POOL.length) throw new Error('mixed corpus requires article and social records');\nconst articleCount = ARTICLE_POOL.length;\nconst socialCount = SOCIAL_POOL.filter(i=>archive[i].kind==='social').length;\nconst bridgeCount = SOCIAL_POOL.length-socialCount;\nconst archiveInfo = buildArchiveMetadata(archive);")
replace('scripts/build.mjs',
"    o:article.attribution || '',\n    q:relatedFor(index),",
"    o:article.attribution || '',\n    k:article.kind==='social'?1:article.kind==='bridge'?2:0,\n    j:article.resurfaced || '2026-07-11',x:article.community || '',v:Number(article.score||0),w:Number(article.comments||0),f:article.outbound_url || '',m:article.synthetic?1:0,g:Math.round(Number(article.revival_score||0)*100),\n    q:relatedFor(index),")
replace('scripts/build.mjs',
"  const articleIndex = Math.floor(rand(id, 100) * archive.length) % archive.length;",
"  const pool = id % 2 === 0 ? ARTICLE_POOL : SOCIAL_POOL;\n  const articleIndex = pool[Math.floor(rand(id,100)*pool.length)%pool.length];")
replace('scripts/build.mjs',
"    q:lateral?1:0,w:visual,y:article.published,z:articleIndex\n  };",
"    q:lateral?1:0,w:visual,y:article.published,z:articleIndex,o:article.kind==='social'?1:article.kind==='bridge'?2:0,j:article.resurfaced || '2026-07-11'\n  };")
old="""  corpus:{
    mode:corpusMode,
    name:corpusMode==='wikinews-archive'?'English Wikinews archive through 2017':'deterministic synthetic fallback',
    articles:archive.length,
    cutoff:'2017-12-31',
    source:'https://dumps.wikimedia.org/enwikinews/latest/enwikinews-latest-pages-articles.xml.bz2',
    license:corpusMode==='wikinews-archive'?'CC BY 2.5; attribution: Wikinews':'prototype synthetic',
    note:'One million candidate instances are generated from the archived article repository; candidate count is not unique article count.'
  },"""
new="""  corpus:{
    mode:'2010s-archive-social',name:'2010s archive + social mirror',articles:archive.length,
    archiveArticles:articleCount,socialRecords:socialCount,generatedBridges:bridgeCount,
    dateRange:['2010-01-01','2019-12-31'],resurfacedAt:'2026-07-11',
    source:'English Wikinews + public Hacker News story records',
    license:'Wikinews CC BY 2.5; HN public metadata; linked content retains original rights',
    note:'Candidate IDs alternate article/social pools exactly. Generated revival bridges are explicitly labeled and never attributed to real users.'
  },"""
replace('scripts/build.mjs',old,new)
replace('scripts/build.mjs',
"    p:'primary-source flag',q:'latent retrieval family: 0 exploit / 1 lateral',w:'visual index',y:'publication date',z:'article index'",
"    p:'primary-source flag',q:'latent retrieval family: 0 exploit / 1 lateral',w:'visual index',y:'original publication date',z:'content index',o:'kind 0 article / 1 social / 2 bridge',j:'resurfaced date'")
replace('scripts/build.mjs',
"  articleFields:{i:'article index',p:'Wikinews page id',h:'title',d:'dek',b:'paragraphs',y:'published date',r:'revision timestamp',a:'contributor',c:'categories',s:'cited sources',u:'canonical URL',l:'license',o:'attribution',q:'related article indexes',n:'topic domain',e:'source index'},",
"  articleFields:{i:'content index',p:'source-native id',h:'title',d:'dek',b:'paragraphs',y:'published date',r:'revision timestamp',a:'contributor',c:'categories',s:'linked sources',u:'canonical URL',l:'license',o:'attribution',q:'related indexes',n:'topic domain',e:'source index',k:'kind',j:'resurfaced date',x:'community',v:'score',w:'comments',f:'outbound URL',m:'synthetic flag',g:'revival score'},\n  contentKinds:['article','social','bridge'],")
replace('scripts/build.mjs',
"await writeFile(join(dataDir,'source-index.json'),JSON.stringify(sourceIndex));\nprocess.stdout.write(`dist ready: ${COUNT.toLocaleString()} candidates, ${archive.length.toLocaleString()} archive articles, ${chunks.toLocaleString()} chunks\\n`);",
"await writeFile(join(dataDir,'source-index.json'),JSON.stringify(sourceIndex));\nawait writeFile(join(dataDir,'mix.json'),JSON.stringify({articleCandidates:Math.ceil(COUNT/2),socialCandidates:Math.floor(COUNT/2),archiveArticles:articleCount,socialRecords:socialCount,generatedBridges:bridgeCount}));\nprocess.stdout.write(`dist ready: ${COUNT.toLocaleString()} candidates, ${articleCount.toLocaleString()} articles + ${(socialCount+bridgeCount).toLocaleString()} social records, ${chunks.toLocaleString()} chunks\\n`);")

replace('src/app.js',
"    published:raw.y,\n    articleIndex:raw.z",
"    published:raw.y,resurfaced:raw.j || null,kind:(m.contentKinds || ['article','social','bridge'])[raw.o ?? 0] || 'article',\n    articleIndex:raw.z")
replace('src/app.js',
"  node.querySelector('.age').textContent = humanDate(post.published);",
"  const kindLabel=post.kind==='article'?'archive':post.kind==='bridge'?'prototype social':'social';\n  node.querySelector('.age').textContent=`${kindLabel} · ${humanDate(post.published)}`;")
replace('src/app.js',
"  const row=element('div','page-head-row'); row.append(backButton(),element('div','page-kicker',humanDate(article.y)));",
"  const articleKind=(state.manifest.contentKinds || ['article','social','bridge'])[article.k ?? 0] || 'article';\n  const kindLabel=articleKind==='article'?'archive journalism':articleKind==='bridge'?'generated revival bridge':'social archive';\n  const row=element('div','page-head-row'); row.append(backButton(),element('div','page-kicker',`${kindLabel} · ${humanDate(article.y)}`));")
replace('src/app.js',
"  addMeta('archive',state.manifest.corpus?.name);\n  addMeta('page id',article.p);\n  addMeta('contributor',article.a || 'Wikinews contributors');",
"  addMeta('repository',state.manifest.corpus?.name);\n  addMeta(articleKind==='article'?'page id':'record id',article.p);\n  addMeta('kind',articleKind);\n  addMeta('contributor',article.a || (articleKind==='article'?'Wikinews contributors':'unknown'));\n  addMeta('community',article.x); addMeta('published',article.y); addMeta('resurfaced',article.j);\n  if (articleKind!=='article') { addMeta('score',article.v); addMeta('comments',article.w); }\n  if (article.m) addMeta('prototype note','generated record — not attributed to a real user');")
replace('src/app.js',
"    const a=element('a','archive-link','open canonical Wikinews page');",
"    const a=element('a','archive-link',articleKind==='article'?'open canonical Wikinews page':articleKind==='bridge'?'prototype record':'open original social record');")
replace('src/app.js',"    view.append(element('h2','section-label','related archive stories'));","    view.append(element('h2','section-label','related records'));")
replace('src/app.js',
"    const articleCount=state.manifest.corpus?.articles || 0;\n    els.corpusStatus.textContent=`${articleCount.toLocaleString()} articles · ${state.manifest.count.toLocaleString()} candidates`;",
"    const archiveCount=state.manifest.corpus?.archiveArticles || 0; const socialCount=(state.manifest.corpus?.socialRecords || 0)+(state.manifest.corpus?.generatedBridges || 0);\n    els.corpusStatus.textContent=`${archiveCount.toLocaleString()} articles · ${socialCount.toLocaleString()} social records · ${state.manifest.count.toLocaleString()} candidates`;")
print('patched build and browser for mixed corpus')
