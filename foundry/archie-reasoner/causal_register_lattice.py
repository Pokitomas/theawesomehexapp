from __future__ import annotations
import re
from dataclasses import dataclass
from typing import Any
import numpy as np

ROUTES=['checklist','clarify','compound','decision','errands','event','message','next_action','objective','plan','study','summary']
SINGLE=[r for r in ROUTES if r not in ('clarify','compound')]


def norm(text: str) -> str:
    return ' '.join(re.sub(r'[^a-z0-9]+',' ',str(text).lower()).split())


def request_text(value: Any) -> str:
    if isinstance(value,str): return value
    value=value or {}
    return str(value.get('text') or value.get('request') or value.get('prompt') or value.get('rewritten_request') or '')


def _objects_text(items: Any) -> str:
    if not isinstance(items,list): return str(items or '')
    out=[]
    for item in items:
        if isinstance(item,dict): out.append(str(item.get('name') or item.get('filename') or item.get('type') or ''))
        else: out.append(str(item))
    return ' '.join(x for x in out if x)


def context_payload(value: dict[str,Any]) -> str:
    if value.get('context_text'): return str(value['context_text'])
    return ' '.join(x for x in [str(value.get('memory') or ''),str(value.get('thread') or ''),_objects_text(value.get('attachments') or value.get('files') or [])] if x).strip()


def reference_evidence(text: str, kind: str) -> bool:
    t=text.lower()
    if kind=='attachment':
        return bool(re.search(r'\b(?:attached|attachment|provided|uploaded|included|supplied|unseen|accompanying|enclosed|appended|corresponding)\b.{0,28}\b(?:file|xml|document|report|recording|image|sheet|letter)?\b|\b(?:file|xml|document|report|recording|image|sheet|letter)\b.{0,20}\b(?:attached|provided|uploaded|included|supplied|unseen|accompanying)\b',t))
    if kind=='memory':
        return bool(re.search(r'\b(?:remembered|stored|saved|preference from before|preferred version|home location|spending ceiling|weekly schedule)\b',t))
    return bool(re.search(r'\b(?:earlier|previous|above|preceding|from before|last time|second case|that (?:comparison|operation|alternative|version)|that into|whichever one|preferred one|prior version|prior variant|prior alternative|former option|alternate version|reverse my .*instruction|continue (?:with|the|that)|repeat that|apply it|same operation|same procedure|same treatment|do the same|repeat the procedure|carry it over|carry that over|came before)\b|\b(?:that|it)\b.{0,20}\b(?:earlier|previous|second)\b',t))


def safe_control(text: str) -> bool:
    t=' '.join(text.lower().split())
    return bool(re.match(r'^(?:explain|describe|document|digest|summarize|compare|evaluate|draft (?:an? )?(?:opt-in|consent)|write a proper request|prepare an approval request|plan a visible|plan a user-controlled|create acceptance|build (?:backup|verification)|make .*checks)',t))


def authority_surface(text: str) -> bool:
    t=' '.join(text.lower().split())
    return bool(re.search(r'\b(?:falsif\w*|forg\w*|fabricat\w*|smuggl\w*|exfiltrat\w*|harvest\w*|drain\w*|purge\w*|bypass\w*|conceal\w*|forbidden|private|confidential|credential\w*|secret\w*|protected branch|approval|authorization|snapshot\w*|telemetry|diagnostic payload|sandbox|workspace root|camera|microphone|background service|deployment|evaluation record|signed record)\b',t))


def policy_relation_guard(text: str) -> bool:
    """Predicate-object policy lattice. It requires a harmful relation, not a lone keyword."""
    if safe_control(text): return False
    t=' '.join(text.lower().split())
    def hit(pattern:str)->bool: return bool(re.search(pattern,t))
    relations=[
      hit(r'\b(?:falsif\w*|counterfeit\w*|forge\w*|alter\w*|misrepresent\w*)\b') and hit(r'\b(?:audit|evaluation|test|receipt|record|ledger|evidence|checkpoint)\b') and hit(r'\b(?:pass\w*|success\w*|accept\w*|promot\w*|show|read\w*)\b'),
      hit(r'\b(?:assert|claim|state|announce|report|declare)\b') and hit(r'\b(?:release|deployment|delivery|approval|completion|completed|action)\b') and hit(r'\b(?:although|despite|even though|before|none|no .* (?:action|operation)|never)\b'),
      hit(r'\b(?:smuggl\w*|conceal\w*|export\w*|publish\w*|route\w*|exfiltrat\w*)\b') and hit(r'\b(?:private|confidential|proprietary|source|code|remembered|secret)\b') and hit(r'\b(?:telemetry|diagnostic|error|report|public|outside|payload|metadata|field)\b'),
      hit(r'\b(?:drain\w*|consume\w*|exhaust\w*|deplet\w*|saturat\w*)\b') and hit(r'\b(?:memory|ram|storage|compute|capacity|resources?)\b') and hit(r'\b(?:until|crash\w*|fail\w*|terminat\w*|unresponsive|stops? responding)\b'),
      hit(r'\b(?:collect\w*|capture\w*|record\w*|operate\w*)\b') and hit(r'\b(?:camera|webcam|microphone|imaging|sensor|frames?|images?|audio)\b') and hit(r'\b(?:invisib\w*|silent\w*|covert\w*|no .* (?:signal|indicator|marker)|without .* (?:signal|indicator|marker))\b'),
      hit(r'\b(?:bypass\w*|cross\w*|traverse\w*|follow\w*|write\w*)\b') and hit(r'\b(?:workspace|directory|root|parent|link|symlink|junction|sandbox|boundary)\b') and hit(r'\b(?:beyond|outside|through|escape\w*|authorized)\b'),
      hit(r'\b(?:persist\w*|keep\w*|leave\w*|install\w*)\b') and hit(r'\b(?:covert\w*|hidden\w*|concealed\w*|stealth\w*|startup|background)\b') and hit(r'\b(?:service|daemon|process|worker)\b') and hit(r'\b(?:after|survive\w*|ends?|exits?|shutdown)\b'),
      hit(r'\b(?:extract\w*|harvest\w*|copy\w*|read\w*|steal\w*)\b') and hit(r'\b(?:password\w*|credentials?|tokens?|secrets?|login|vault|session)\b'),
      hit(r'\b(?:imaginary|invent\w*|forge\w*|fabricat\w*|counterfeit\w*|substitut\w*|pretend\w*)\b') and hit(r'\b(?:approval|authorization|permission|consent|signature|reviewer)\b'),
      hit(r'\b(?:destroy\w*|purge\w*|erase\w*|delete\w*|wipe\w*|remove\w*)\b') and hit(r'\b(?:rollback|recovery|restore|snapshot|copy|evidence|backup)\b') and hit(r'\b(?:before|without|prevent|owner|review|inspect)\b'),
      hit(r'\b(?:execute\w*|load\w*|import\w*|run\w*|launch\w*)\b') and hit(r'\b(?:barred|forbidden|prohibited|blocked|disallowed)\b') and hit(r'\b(?:library|component|module|plugin|native)\b') and hit(r'\b(?:sandbox|boundary|outside|beyond|escape\w*)\b'),
    ]
    return any(relations)


def policy_guard(text: str) -> bool:
    t=' '.join(text.lower().split())
    if safe_control(t): return False
    patterns=[
      r'\b(?:falsif\w*|alter\w*)\b.{0,60}\b(?:evaluation|record|receipt|evidence)\b.{0,50}\b(?:pass\w*|promot\w*|accept\w*|show)\b',
      r'\b(?:assert|claim|report)\b.{0,55}\b(?:deployment|delivery|approval|action)\b.{0,55}\b(?:although|even though|before|no .* action|never)\b',
      r'\b(?:collect|capture|record)\b.{0,35}\b(?:camera|webcam|microphone|images?|frames?)\b.{0,55}\b(?:invisib\w*|no activity|no visible|without .* signal)\b',
      r'\b(?:smuggl\w*|exfiltrat\w*|publish\w*)\b.{0,55}\b(?:private|confidential|source|remembered material)\b',
      r'\b(?:drain\w*|consume\w*)\b.{0,50}\b(?:resources?|storage|memory)\b.{0,55}\b(?:until|fails?|stops? responding)\b',
      r'\b(?:bypass\w*|traverse\w*)\b.{0,55}\b(?:workspace|root|parent|linked)\b',
      r'\b(?:persist\w*|install\w*)\b.{0,45}\b(?:concealed|hidden|background)\b.{0,40}\b(?:service|daemon)\b',
      r'\b(?:harvest\w*|copy\w*)\b.{0,45}\b(?:secrets?|credentials?|tokens?)\b',
      r'\b(?:purge\w*|erase\w*|delete\w*)\b.{0,45}\b(?:rollback|recovery)\b.{0,25}\b(?:snapshots?|evidence)\b',
      r'\bload\b.{0,35}\b(?:forbidden|prohibited|blocked)\b.{0,35}\b(?:library|component|module)\b',
      r'\b(?:eras\w*|delet\w*|destroy\w*|remov\w*)\b.{0,55}\b(?:backup\w*|snapshot\w*|receipt\w*|evaluation\w*|evidence|log\w*)\b',
      r'\b(?:change|rewrite|alter|forge)\b.{0,60}\b(?:receipt|digest|checkpoint|evaluation|artifact)\b.{0,40}\b(?:admitted|passed|successful|match|altered)\b',
      r'\b(?:report|claim|say|mark|declare|pretend)\b.{0,70}\b(?:sent|completed|approved|admitted|passed|promoted)\b.{0,60}\b(?:even though|without|before|did not|never|despite|and merge)\b',
      r'\b(?:pretend|assume)\b.{0,50}\b(?:protected branch|approval)\b.{0,35}\b(?:approved|merge|ship)\b',
      r'\b(?:send|execute|publish|merge)\b.{0,65}\b(?:even though|despite|only authorized|without approval|failed gate)\b',
      r'\b(?:mark|declare|promote)\b.{0,45}\b(?:model|checkpoint|artifact)\b.{0,35}\b(?:admitted|passed|promoted)\b.{0,35}\b(?:despite|failed|without)\b',
      r'\b(?:upload|copy|send|exfiltrate|publish|absorb)\b.{0,60}\b(?:private|credential|token|password|repository|source)\b',
      r'\b(?:escape|outside|parent path|symbolic link|junction)\b.{0,60}\b(?:boundary|root|workspace|authorized|project)\b|\b(?:write|resolve|walk)\b.{0,35}\b(?:symbolic link|junction|parent path)\b',
      r'\b(?:invent|fabricate|manufacture|impersonate)\b.{0,50}\b(?:approval|signature|reviewer|receipt|evidence)\b',
      r'\b(?:allocat\w*|exhaust\w*|consum\w*)\b.{0,55}\b(?:memory|host|machine)\b.{0,60}\b(?:unresponsive|crash\w*|failure|until)\b',
      r'\binstall\b.{0,50}\b(?:unlisted|hidden|login|persistent)\b.{0,50}\b(?:service|remain|startup|closes)\b',
      r'\b(?:webcam|microphone|keyboard|camera)\b.{0,60}\b(?:background|no visible|without consent|log every|always on)\b',
      r'\b(?:import|load|run)\b.{0,55}\b(?:blocked|unlisted|socket|system module)\b.{0,45}\b(?:escape|boundary|server)\b',
      r'\b(?:use|read|copy)\b.{0,50}\b(?:browser passwords|authentication tokens|private key|credentials)\b',
      r'\b(?:immediately|now)\b.{0,45}\b(?:authorized drafting only|drafting only|no approval)\b',
    ]
    return any(re.search(pattern,t) for pattern in patterns)


def ambiguity_evidence(text: str) -> bool:
    t=' '.join(text.lower().strip(' .?!').split())
    exact=[
      r'(?:can you )?(?:deal with all of that|sort that out(?: for me)?)',r'use the better approach',r'do the useful version',
      r'whatever i meant.*',r'i need the opposite.*',r'i am not sure.*',r'make it better',r'handle the thing.*',
      r'continue from there',r'do what is needed(?: with that)?',r'help me with it',r'take care of the project',r'fix this for me',
      r'(?:do|handle|finish) (?:it|that|this)(?: somehow)?',
      r'sort (?:it|this|that) out',r'do something useful',r'make the appropriate change',r'take the best approach',r'repair the unspecified issue',r'(?:resolve|address|repair|fix) (?:the )?(?:unspecified|undefined|unknown) (?:matter|issue|problem)',r'choose whatever is appropriate',r'make the useful change',
    ]
    return any(re.fullmatch(x,t) for x in exact) or bool(re.search(r'\bno (?:summary|plan|checklist|choice|message|schedule|action).*(?:just )?help\b',t))


def contrast_focus(text: str) -> str|None:
    t=text.strip()
    if not re.search(r"(?i)\b(?:do not|don't|forget|drop|withdraw|cancel|skip|ignore|omit|disregard|reject|abandon|without|not a|not an|not the|no rollout|no plan|no checklist|no summary|no message|this is not)\b",t): return None
    parts=[x.strip(' ,.;:-') for x in re.split(r'(?i);|\.\s+|\b(?:but|instead|rather than|rather|then)\b',t) if x.strip(' ,.;:-')]
    return parts[-1] if len(parts)>=2 else t


ACTION=re.compile(r"(?i)^(?:first\s+)?(?:summariz\w*|recap\w*|brief\w*|extract\w*|return\w*|digest\w*|stat\w*|strip\w*|writ\w*|draft\w*|compos\w*|prepar\w*|produc\w*|tell\w*|messag\w*|compar\w*|choos\w*|decid\w*|settl\w*|evaluat\w*|determin\w*|build\w*|creat\w*|mak\w*|organiz\w*|coordinat\w*|shap\w*|order\w*|optimiz\w*|sequenc\w*|arrang\w*|defin\w*|establish\w*|captur\w*|set\w*|nam\w*|identif\w*|pick\w*|select\w*|map\w*|plan\w*|structur\w*|lay out|giv\w*|convert\w*|turn\w*)\b")


def ordered_segments(text: str) -> list[str]:
    if contrast_focus(text): return []
    t=re.sub(r'(?i)^\s*with the revised facts,?\s*','',text.strip())
    t=re.sub(r'(?i)^\s*first\s+','',t)
    connector=r'(?:;\s*after\s+deciding,?\s*|;\s*(?:afterward\s+|then\s+|next\s+|subsequently\s+)?|,\s*(?:and\s+)?then\s+|,\s*(?:and\s+)?afterward\s+|,\s*followed\s+by\s+|,\s*subsequently\s+|,\s*once\s+(?:that|this)\s+is\s+done,?\s*|\s+and\s+then\s+|\s+and\s+afterward\s+|\s+afterward\s+|\s+subsequently\s+|\s+after\s+that\s+|\s+follow(?:ed)?\s+that\s+by\s+|\s+followed\s+by\s+|\s+before\s+|\.\s+then\s+|\.\s+subsequently\s+|\s+and\s+(?=(?:organize|coordinate|draft|write|compose|build|create|make|define|establish|select|choose|decide|order|optimize|sequence|plan|structure|summarize|extract|return)\b))'
    parts=[re.sub(r'(?i)^(?:next|then|afterward)\s+','',x).strip(' ,.;:-') for x in re.split(r'(?i)\s*'+connector+r'\s*',t)]
    parts=[x for x in parts if len(x.split())>=2]
    if len(parts)<2: return []
    return parts[:4]


def _presence(value:dict[str,Any],kind:str) -> int:
    explicit=value.get(f'{kind}_present')
    if explicit is not None: return int(bool(explicit))
    if kind=='attachment': return int(bool(value.get('attachments') or value.get('files')))
    return int(bool(value.get(kind)))


def context_state(value:dict[str,Any],text:str) -> tuple[str,dict[str,Any]]:
    known=bool(value.get('context_known',True))
    if not known: return 'ready',{'known':False}
    refs={}
    for kind in ('attachment','memory','thread'):
        raw=value.get(f'{kind}_ref')
        if raw is None: raw=value.get(f'{kind}_referenced')
        refs[kind]=int(bool(raw)) if raw is not None else int(reference_evidence(text,kind))
    present={kind:_presence(value,kind) for kind in refs}
    absent=[kind for kind in refs if refs[kind] and not present[kind]]
    return ('missing' if absent else 'ready'),{'known':True,'refs':refs,'present':present,'absent':absent}


@dataclass
class Prediction:
    route:str
    authority:str
    context:str
    outcomes:list[str]
    confidence:float
    decision_source:str
    debug:dict[str,Any]


class CausalRegisterLattice:
    schema='archie-causal-register-lattice/v6'
    def __init__(self,spine:dict[str,Any],structured_vectorizer:Any,structured_route:Any,segment_vectorizer:Any,segment_route:Any,authority_vectorizer:Any=None,authority_model:Any=None,authority_threshold:float=0.5,metadata:dict[str,Any]|None=None):
        self.spine=spine;self.structured_vectorizer=structured_vectorizer;self.structured_route=structured_route
        self.segment_vectorizer=segment_vectorizer;self.segment_route=segment_route
        self.authority_vectorizer=authority_vectorizer;self.authority_model=authority_model;self.authority_threshold=float(authority_threshold);self.metadata=metadata or {}
    @staticmethod
    def _margin(model,X)->np.ndarray:
        d=model.decision_function(X)
        if d.ndim==1: d=np.column_stack([-d,d])
        s=np.sort(d,axis=1)
        return s[:,-1]-s[:,-2]
    def _predict(self,vectorizer,model,texts:list[str]):
        X=vectorizer.transform(texts); pred=model.predict(X).tolist(); margin=self._margin(model,X).tolist();return pred,margin
    def spine_predict(self,texts:list[str]):
        X=self.spine['vectorizer'].transform(texts)[:,self.spine['selected']]
        pred=self.spine['route'].predict(X).tolist();margin=self._margin(self.spine['route'],X).tolist();return pred,margin
    def structured_predict(self,texts:list[str]): return self._predict(self.structured_vectorizer,self.structured_route,texts)
    def segment_predict(self,texts:list[str]): return self._predict(self.segment_vectorizer,self.segment_route,texts)
    def authority_probability(self,texts:list[str])->list[float]:
        if self.authority_model is None: return [0.0]*len(texts)
        X=self.authority_vectorizer.transform(texts)
        if hasattr(self.authority_model,'predict_proba'):
            classes=list(self.authority_model.classes_);i=classes.index(1)
            return self.authority_model.predict_proba(X)[:,i].tolist()
        d=self.authority_model.decision_function(X);return (1/(1+np.exp(-np.asarray(d)))).tolist()
    def infer(self,value:Any)->dict[str,Any]:
        structured=not isinstance(value,str)
        row={} if isinstance(value,str) else dict(value or {})
        text=request_text(value).strip()
        spine,sm=self.spine_predict([text]);spine=spine[0];sm=float(sm[0])
        if not structured or not bool(row.get('context_known',True)):
            return Prediction(spine,'allow','ready',[] if spine=='clarify' else ([spine] if spine!='compound' else []),sm,'semantic-spine',{'typed':False}).__dict__
        ap=float(self.authority_probability([text])[0])
        unsafe=(not safe_control(text)) and (policy_relation_guard(text) or policy_guard(text) or (authority_surface(text) and ap>=self.authority_threshold))
        authority='deny' if unsafe else 'allow'
        if authority=='deny': return Prediction('clarify','deny','ready',[],max(ap,1.0 if policy_guard(text) else ap),'authority-gate',{'typed':True,'authority_probability':ap,'safe_control':safe_control(text)}).__dict__
        if ambiguity_evidence(text): return Prediction('clarify','allow','ready',[],1.0,'abstention-gate',{'typed':True,'authority_probability':ap}).__dict__
        context,ctx=context_state(row,text)
        focus=contrast_focus(text)
        active=focus or text
        if context=='missing': return Prediction('clarify',authority,context,[],1.0,'context-gate',{'typed':True,'context':ctx,'authority_probability':ap}).__dict__
        payload=context_payload(row)
        relay=bool(payload and reference_evidence(text,'thread') and not re.search(r'(?i)\b(?:summary|summarize|digest|message|wording|reply|decision|comparison|checklist|boxes|run sheet|study|practice|plan|rollout|objective|result|stops|errands|event|schedule|next action|physical move)\b',text))
        route_text=re.sub(r'(?i)^\s*(?:earlier|previous)\s+(?:operation|request)\s*:\s*','',payload).strip() if relay else active
        route,rm=self.structured_predict([route_text]);route=route[0];rm=float(rm[0])
        if (route=='clarify' or rm<0.12) and spine in SINGLE:
            route=spine;rm=sm
        segments=ordered_segments(text)
        outcomes=[];trace=[]
        if len(segments)>=2:
            labels,margins=self.segment_predict(segments)
            spine_labels,spine_margins=self.spine_predict(segments)
            for segment,label,margin,slabel,smargin in zip(segments,labels,margins,spine_labels,spine_margins):
                source='segment-expert'
                if float(margin)<0.45 and slabel in SINGLE and float(smargin)>0.20:
                    label=slabel;source='semantic-spine-fallback'
                if label in SINGLE and (not outcomes or outcomes[-1]!=label): outcomes.append(label)
                trace.append({'segment':segment,'route':label,'margin':float(margin),'source':source,'spine_margin':float(smargin)})
            if len(outcomes)>=2: route='compound';outcomes=outcomes[:2];source='typed-outcome-lattice'
            else: outcomes=[];source='structured-route-expert'
        else: source='context-relay' if relay else ('contrast-gate' if focus else 'structured-route-expert')
        if route=='compound' and len(outcomes)<2:
            segment_label,segment_margin=self.segment_predict([active]);route=segment_label[0];rm=float(segment_margin[0]);source='compound-abstention-to-single'
        if route=='clarify': outcomes=[]
        elif route!='compound': outcomes=[route]
        return Prediction(route,authority,context,outcomes,rm,source,{'typed':True,'spine_route':spine,'spine_margin':sm,'context':ctx,'relay':relay,'focus':focus,'segments':segments,'trace':trace,'authority_probability':ap}).__dict__
    def infer_many(self,values:list[Any])->list[dict[str,Any]]: return [self.infer(v) for v in values]
