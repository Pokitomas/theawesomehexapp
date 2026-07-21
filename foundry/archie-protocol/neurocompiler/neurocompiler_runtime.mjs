const TOKEN_RE = /[a-z0-9]+(?:['-][a-z0-9]+)*/g;
const RAW_SOURCE_RE = /(?:template\s*<|#include|struct\s+\w+\s*\{|\bdef\s+\w+\(|\bclass\s+\w+\s*[:{]|\bfn\s+\w+\s*\(|\bfunction\s+\w+\s*\(|\bimpl\s+\w+\s*\{|\bconst\s+\w+\s*=\s*\(|public\s+static\s+void\s+main)/i;
const CORR_PATTERNS = [
  /disregard that request and instead/i,
  /the replacement is/i,
  /replace (?:that|it|the (?:prior|earlier) request) with/i,
  /do this instead/i,
  /correction\s*:/i,
  /actually[, :]/i,
];
const CORR_RE = /disregard that request and instead|the replacement is|replace (?:that|it|the (?:prior|earlier) request) with|do this instead|correction\s*:|actually[, :]/i;
const NEG_PREFIX = /^(?:do not|don't|skip|ignore|leave out|omit|avoid|exclude|discard)\b/i;
const NEG_ANY = /\b(?:do not|don't|skip|ignore|leave out|omit|avoid|exclude|discard)\b/i;
const AUTHORITY_OP_RE = /\b(?:exfiltrate|steal|siphon|forge|erase|delete|overwrite|disable|conceal|implant|tamper|bypass|leak|extract)\b/i;
const AUTHORITY_TARGET_RE = /\b(?:secret|token|credential|approval ledger|audit (?:trail|record|log)|ledger|vault|backup|authorization record|security log|owner record|private key|owner-consent record|signing key)\b/i;
const AUTHORITY_NO_PERMISSION_RE = /\b(?:without|no)\b.{0,48}\b(?:authori[sz]ation|approval|permission|consent)\b/i;
const SAFE_DOC_RE = /^(?:create (?:a defensive control plan|binary pre-release verification gates)|document (?:a harmless resilience exercise|defensive controls)|describe non-invasive safeguards|draft a containment checklist|explain (?:safe custody|safe stewardship|safe handling)|make (?:containment acceptance tests|a containment checklist)|plan (?:an observation-only review|a read-only (?:inspection|audit))|write (?:read-only validation checks|non-destructive verification tests)|specify non-destructive tests|summarize (?:the prohibition on changing|why modification|why operators must not alter))\b/i;
const CONNECTORS = [
  /\s*;\s*(?:carry out only|followed by|only after that|after that|after completion|afterward|next|following completion|upon completion|subsequently|and then|then|once verified|once complete)\s*[:,]?\s*/i,
  /\s+(?:once|when) that is complete,?\s+/i,
  /\s*,?\s+and (?:in )?the next step\s+/i,
  /\.\s*(?:when that is complete|once that is complete|after that|afterward|next|then|upon completion|following completion)\s*[,;:]?\s*/i,
  /\s*[—-]\s*(?:only\s+)?(?:afterward|then|next)\s*,?\s*/i,
  /\s+(?:and subsequently|and afterward|and then|plus|as well as|along with|while also)\s+/i,
  /\s*;\s*(?:also\s+)?(?=(?:draft|compose|write|prepare|summar|condense|brief|extract|compare|choose|decide|select|plan|map|outline|schedule|organize|coordinate|check|verify|define|set|identify|pick|rank|build|construct|return|produce|convert|make|form|supply|adjudicate|settle|resolve|design|assemble|lay out|calculate|order|optimize|arrange|declare|formalize|state|lock|reduce|turn|give|create|enumerate|express|shape|surface|name|sequence|break|evaluate|distill|synthesize)\b)/i,
];
const WRAPPER_RE = /^(?:for the operating review,?|for the duty officer,?|as an operator handoff,?|as an operational handoff,?|for the incident lead,?|for the next control meeting,?|for the control-room review,?|for an accountable reviewer,?|without adding unsupported material,?|without unsupported assumptions,?|keep every inference evidence-bounded and|keep every claim evidence-bounded and|keep unsupported assumptions out and|the output must be deployable:|the result must be directly usable;?|the team has limited attention;?|using plain language,?|use direct language and|use compact language,? but|treat this as a real handoff and|treat this as an operational handoff and|this is a real operational handoff:|i need a usable artifact now:|base the answer on [^,]+ and|using the [^,]+,?|ground the answer in [^,]+ while you|build from the [^,]+ and|respect my [^,]+ while you|use the [^,]+ as context and|carry forward the [^,]+ while you|extend the [^,]+ and|apply my [^,]+ while you|you\s+)\s*/i;

function hardAuthorityDeny(text) {
  return AUTHORITY_OP_RE.test(text) && AUTHORITY_TARGET_RE.test(text) && AUTHORITY_NO_PERMISSION_RE.test(text) && !SAFE_DOC_RE.test(text);
}

function explicitReference(text) {
  const normalized = normalize(text);
  if (/\b(?:using|from|based on|ground the answer in|use) (?:the )?(?:uploaded|attached|enclosed|submitted|provided)\b/i.test(normalized)) return 'attachment';
  if (/\b(?:apply|respect|use|carry forward) (?:my )?(?:saved|remembered|persistent|stored|long-lived)\b/i.test(normalized)) return 'memory';
  if (/\b(?:build from|extend|continue from) (?:the )?(?:earlier|prior|preceding|conversation-so-far|previous)\b/i.test(normalized)) return 'thread';
  return null;
}

function explicitRoute(text) {
  const normalized = normalize(text);
  if (/\broadmap\b/i.test(normalized)) return 'plan';
  if (/\brun-of-show\b/i.test(normalized)) return 'event';
  return null;
}

function safeDocumentationRoute(text) {
  if (!(SAFE_DOC_RE.test(text) && AUTHORITY_TARGET_RE.test(text))) return null;
  const normalized = normalize(text);
  if (/\b(?:explain|summarize|why)\b/i.test(normalized)) return 'summary';
  if (/\b(?:tests?|checks?|checklist|containment|gates?)\b/i.test(normalized)) return 'checklist';
  if (/\b(?:document|plan|audit)\b/i.test(normalized)) return 'plan';
  return 'plan';
}

function normalize(value) {
  return String(value ?? '').toLowerCase().replaceAll('’', "'").trim().replace(/\s+/g, ' ');
}

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function addFeature(values, feature, dim, weight = 1) {
  const index = fnv1a(feature) % dim;
  const sign = (fnv1a(`s|${feature}`) & 1) === 0 ? 1 : -1;
  values.set(index, (values.get(index) || 0) + sign * weight);
}

function pyValue(value) {
  if (value === true) return 'True';
  if (value === false) return 'False';
  return String(value);
}

function featureVector(text, dim, namespace = 'REQ', structural = null) {
  const normalized = normalize(text);
  const words = normalized.match(TOKEN_RE) || [];
  const values = new Map();
  for (const word of words) addFeature(values, `${namespace}|w|${word}`, dim);
  for (const ngram of [2, 3]) {
    for (let index = 0; index <= words.length - ngram; index += 1) {
      addFeature(values, `${namespace}|g${ngram}|${words.slice(index, index + ngram).join('_')}`, dim);
    }
  }
  for (const word of words) {
    const marked = `^${word}$`;
    for (const ngram of [3, 4, 5]) {
      for (let index = 0; index <= marked.length - ngram; index += 1) {
        addFeature(values, `${namespace}|c${ngram}|${marked.slice(index, index + ngram)}`, dim, 0.45);
      }
    }
  }
  const flags = {
    question: normalized.includes('?'),
    semicolon: normalized.includes(';'),
    colon: normalized.includes(':'),
    ordered: /\b(?:afterward|after that|following completion|upon completion|subsequently|and then|when that is complete|once that is complete|before)\b/i.test(normalized),
    correction: CORR_RE.test(normalized),
    negation: NEG_ANY.test(normalized),
    raw_source: RAW_SOURCE_RE.test(normalized),
    len: Math.min(15, Math.floor(words.length / 5)),
  };
  for (const [key, value] of Object.entries(flags)) addFeature(values, `${namespace}|s|${key}=${pyValue(value)}`, dim, 1.5);
  if (words.length) addFeature(values, `${namespace}|first|${words[0]}`, dim, 1.2);
  if (words.length > 1) addFeature(values, `${namespace}|first2|${words[0]}_${words[1]}`, dim, 1.2);
  if (structural) {
    for (const [key, value] of Object.entries(structural)) addFeature(values, `${namespace}|meta|${key}=${pyValue(value)}`, dim, 2);
  }
  return values;
}

function trimPunctuation(value) {
  return String(value).replace(/^[ .;,:]+|[ .;,:]+$/g, '');
}

function stripWrapper(value) {
  let current = trimPunctuation(String(value).trim().replace(/\s+/g, ' '));
  for (let index = 0; index < 6; index += 1) {
    const updated = trimPunctuation(current.replace(WRAPPER_RE, ''));
    if (updated === current) break;
    current = updated;
  }
  return current;
}

function correctionActive(request) {
  const text = String(request).trim().replace(/\s+/g, ' ');
  for (const pattern of CORR_PATTERNS) {
    const source = pattern.source;
    const match = text.match(new RegExp(`${source}\\s*[:,]?\\s*(.+)$`, 'i'));
    if (match) return match[1].trim();
  }
  return text;
}

function splitClauses(request) {
  const cleaned = trimPunctuation(correctionActive(request).replace(/\s+/g, ' '));
  const lowered = cleaned.toLowerCase();
  if (lowered.startsWith('before ')) {
    const markerText = ', first ';
    const marker = lowered.lastIndexOf(markerText);
    if (marker >= 0) {
      const later = cleaned.slice('before '.length, marker).trim().replace(/^you\s+/i, '');
      const earlier = cleaned.slice(marker + markerText.length).trim();
      return [stripWrapper(earlier), stripWrapper(later)];
    }
    const simple = cleaned.match(/^before(?: you)?\s+([^,]+),\s*(.+)$/i);
    if (simple) return [stripWrapper(simple[2]), stripWrapper(simple[1])];
  }
  const text = stripWrapper(cleaned);
  for (const connector of CONNECTORS) {
    const parts = text.split(connector).map(stripWrapper).filter(Boolean);
    if (parts.length > 1) return parts.slice(0, 4);
  }
  const shared = text.match(/^(create|make|prepare|write|draft|produce|build|form|supply)\s+(.+?)\s+and\s+((?:a|an|the)\s+.+)$/i);
  if (shared) return [`${shared[1]} ${shared[2]}`, `${shared[1]} ${shared[3]}`];
  return [text];
}

function decodeInt8(base64) {
  if (typeof Buffer !== 'undefined') {
    const bytes = Buffer.from(base64, 'base64');
    return new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  const binary = atob(base64);
  const bytes = new Int8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index) > 127 ? binary.charCodeAt(index) - 256 : binary.charCodeAt(index);
  return bytes;
}

export function createNeurocompiler(model) {
  if (model?.schema !== 'archie-segment-neurocompiler-int8/v1') throw new Error('unsupported model schema');
  const heads = Object.fromEntries(Object.entries(model.heads).map(([name, head]) => [name, { ...head, weights: decodeInt8(head.weights_base64) }]));

  function predictHead(name, text, namespace = 'REQ', meta = null) {
    const head = heads[name];
    const dim = Number(head.dim);
    const vector = featureVector(text, dim, namespace, meta);
    let magnitude = 0;
    for (const value of vector.values()) magnitude += value * value;
    magnitude = Math.sqrt(magnitude) || 1;
    const scores = head.intercepts.map(Number);
    for (let classIndex = 0; classIndex < head.classes.length; classIndex += 1) {
      const offset = classIndex * dim;
      const scale = Number(head.scales[classIndex]);
      let score = scores[classIndex];
      for (const [featureIndex, value] of vector.entries()) score += head.weights[offset + featureIndex] * scale * (value / magnitude);
      scores[classIndex] = score;
    }
    let best = 0;
    for (let index = 1; index < scores.length; index += 1) if (scores[index] > scores[best]) best = index;
    return head.classes[best];
  }

  function predict(request, { attachments = '', memory = '', thread = '' } = {}) {
    const learnedAuthority = predictHead('authority', request);
    const authority = hardAuthorityDeny(request) ? 'deny' : 'allow';
    const purpose = RAW_SOURCE_RE.test(request) ? 'raw_source' : predictHead('purpose', request);
    const learnedReference = predictHead('reference', request);
    const reference = explicitReference(request) || (learnedReference === 'ambiguous' ? 'ambiguous' : 'none');
    let transform = predictHead('transform', request);
    if (CORR_RE.test(request)) transform = 'correction';
    else if (NEG_ANY.test(request)) transform = 'negation';
    const explicitTransform = transform === 'correction' || transform === 'negation';
    if (authority === 'deny') return { route: 'clarify', authority: 'deny', context: 'ready', outcomes: [] };
    if (purpose === 'raw_source') return { route: 'clarify', authority: 'allow', context: 'ambiguous', outcomes: [] };
    if (purpose === 'underspecified' && !explicitTransform) return { route: 'clarify', authority: 'allow', context: 'ready', outcomes: [] };
    if ((purpose === 'ambiguous' || reference === 'ambiguous') && !explicitTransform) return { route: 'clarify', authority: 'allow', context: 'ambiguous', outcomes: [] };
    const boundReference = reference === 'ambiguous' ? 'none' : reference;
    if (boundReference !== 'none') {
      const payload = { attachment: attachments, memory, thread }[boundReference];
      if (!String(payload).trim()) return { route: 'clarify', authority: 'allow', context: 'missing', outcomes: [] };
      if (predictHead('payload', payload, 'SRC', { ref: boundReference }) !== 'usable') return { route: 'clarify', authority: 'allow', context: 'missing', outcomes: [] };
    }
    const active = transform === 'correction' ? correctionActive(request) : request;
    let clauses = splitClauses(active);
    if (transform === 'negation' || clauses.some(clause => NEG_PREFIX.test(clause.trim()))) clauses = clauses.filter(clause => !NEG_PREFIX.test(clause.trim()));
    if (!clauses.length) return { route: 'clarify', authority: 'allow', context: 'ambiguous', outcomes: [] };
    const outcomes = clauses.map(clause => safeDocumentationRoute(clause) || explicitRoute(clause) || predictHead('route', clause));
    if (outcomes.length > 1) return { route: 'compound', authority: 'allow', context: 'ready', outcomes };
    return { route: outcomes[0], authority: 'allow', context: 'ready', outcomes };
  }

  return Object.freeze({ predict, predictHead, splitClauses });
}
