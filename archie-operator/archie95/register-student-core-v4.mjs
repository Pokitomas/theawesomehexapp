const ACTIVE_ROUTES = Object.freeze(['summary','checklist','message','decision','study','event','errands','objective','next_action','plan']);

const RAW_SOURCE = /(?:template\s*<|#include|struct\s+\w+\s*\{|\bdef\s+\w+\(|\bclass\s+\w+\s*[:{]|\bfn\s+\w+\s*\(|\bfunction\s+\w+\s*\(|\bimpl\s+\w+\s*\{)/i;
const CLARIFY_EXACT = /^(?:can you (?:deal with all of that|sort that out for me)|use the better approach|do the useful version|whatever i meant yesterday,? reverse it|i need the opposite of whatever i asked before)[.?!]*$/i;
const CLARIFY_NEGATIVE = /^no summary, plan, checklist, choice, message, schedule, or action[—-]just help\.?$/i;
const UNDERSPECIFIED_ARTIFACT = /^(?:please\s+)?(?:make|build|create|draft|write|give|prepare|outline|produce|form)\s+(?:a|an|the)\s+(?:plan|checklist|summary|message|decision|schedule|study|objective|roadmap|brief|reply)(?:\s+please)?[.?!]*$/i;
const CONTRAST_CLARIFY = /\bi do not want a plan checklist summary message decision schedule or next action\b/i;
const DANGEROUS = /\b(?:manufacture an approval|declare .* promoted without|claim a file write completed before|inspect private-key|exhaust machine memory|resolve a junction beyond|pending action as approved|speaker although neither audio|hide local note contents|log every keyboard event|walking through a parent path|destroy the available backups)\b/i;

const UNSAFE_OPERATION = /\b(?:copy|extract|hide|delete|overwrite|forge|bypass|disable|exfiltrate|suppress|siphon|erase|falsify|evade|silence|implant(?: into)?|conceal)\b/i;
const UNSAFE_TARGET = /\b(?:authentication token|access token|private key|signing secret|signing material|approval record|approval ledger|audit log|audit trail|security event log|credential store|credential vault|session secret|owner authorization record|protected backup|security register)\b/i;
const AUTHORIZATION_GAP = /\b(?:without owner (?:approval|authorization)|without approval|without authorization|no permission|not authorized|report it as approved)\b/i;
const SAFE_DOCUMENTATION = /\b(?:safeguard|defensive|why not|containment|safe handling|non-destructive|read-only audit|verification tests?|document .*controls|must not alter)\b/i;

const AMBIGUOUS_REFERENCE = /(?:\bwhatever\b|\bwhichever\b|\bthe right one\b|\bthe better one\b|\bthe relevant (?:thing|instruction|action)\b|\bthe applicable (?:object|thing)\b|\bthe correct version of that\b|\bthe thing above\b|\bthe prior option\b|\bthe way we discussed\b|\bthe right source\b|\bmissing prior choice\b|\bunnamed instruction\b|\bunspecified target\b|\bno (?:item|source|version|answer) (?:is |has been )?(?:referenced|available|identified|exists)\b|\bnone is stated\b|\bno earlier answer exists\b|\balthough no source is available\b|\bno version has been identified\b)/i;
const GENERIC_REFERENCE = /\b(?:that|this|the other|the applicable)\b/i;
const ATTACHMENT_REFERENCE = /\b(?:(?:using|from|based on|review|read|apply)\s+(?:the\s+)?(?:attached|attachment|uploaded|appendix|exhibit|enclosed|submitted|provided (?:worksheet|evidence|bundle)|dossier|workbook|case file|source packet|evidence attachment|uploaded ledger|supplied brief)|ground (?:the )?answer in (?:the )?(?:source packet|evidence attachment|uploaded ledger|supplied brief))\b/i;
const MEMORY_REFERENCE = /\b(?:apply|use|honor|follow)\s+(?:my|our|the)\s+(?:(?:saved|stored|durable|retained|long-lived|remembered|persistent|standing)\s+)?(?:rule|preference|priority|decision boundary|operating constraint|instruction|context|constraint|boundary)\b/i;
const THREAD_REFERENCE = /\b(?:continue|extend|use|build on|build from|based on)\s+(?:the\s+)?(?:prior|previous|earlier|preceding|conversation-so-far|conversation)\s+(?:analysis|conclusion|result|decision|comparison|thread|work|finding)\b/i;
const UNUSABLE_PAYLOAD = /\b(?:unrelated|unusable|no requested support|no support|does not contain|irrelevant)\b/i;
const USABLE_PAYLOAD = /\b(?:usable|support|trusted|verified|corroborated|route state|source-bound|explicit evidence)\b/i;

const NEGATED_PREFIX = /^(?:do not|don't|skip|ignore|leave out|omit|avoid|exclude)\b/i;
const CORRECTION = /(?:\bdisregard that request and instead\b|\breplace (?:that|it) with\b|\bdo this instead\b|\bthe replacement is\b|(?:^|[.;,])\s*instead\b(?!\s+of\b))[:,]?\s*(.+)$/i;

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

export function registerStudentTokens(value) {
  return normalizeText(value).match(/[a-z0-9]+(?:['-][a-z0-9]+)*/g) || [];
}

export function registerStudentFeatures(value) {
  const text = normalizeText(value);
  const words = registerStudentTokens(text);
  const features = [];
  for (const word of words) features.push(`w:${word}`);
  for (let i = 0; i + 1 < words.length; i += 1) features.push(`b:${words[i]}_${words[i + 1]}`);
  for (let i = 0; i + 2 < words.length; i += 1) features.push(`t:${words[i]}_${words[i + 1]}_${words[i + 2]}`);
  for (const word of words) {
    if (word.length > 30) continue;
    const marked = `^${word}$`;
    for (let n = 3; n <= 5; n += 1) {
      for (let i = 0; i + n <= marked.length; i += 1) features.push(`c${n}:${marked.slice(i, i + n)}`);
    }
  }
  if (words.length) {
    features.push(`s:first:${words[0]}`);
    if (words.length > 1) features.push(`s:first2:${words[0]}_${words[1]}`);
  }
  const lengthBucket = Math.min(12, Math.floor(words.length / 5));
  features.push(`s:length:${lengthBucket}`);
  if (/[?]/.test(text)) features.push('s:question');
  if (/;/.test(text)) features.push('s:semicolon');
  if (/\bbefore\b/.test(text)) features.push('s:before');
  if (/\bafter(?:ward| that)?\b|\bonly after that\b|\bfollowing completion\b|\bsubsequently\b/.test(text)) features.push('s:ordered');
  if (/\b(?:and then|then|next|plus|also|as well as|along with|while also)\b/.test(text)) features.push('s:connector');
  if (/\b(?:instead|disregard|replace)\b/.test(text)) features.push('s:correction');
  if (/\b(?:do not|don't|skip|ignore|leave out|omit|avoid)\b/.test(text)) features.push('s:negation');
  if (RAW_SOURCE.test(text)) features.push('s:raw-source');
  return features;
}

function decodeInt8Rows(encodedRows, scales) {
  return encodedRows.map((encoded, index) => {
    const raw = typeof atob === 'function' ? atob(encoded) : Buffer.from(encoded, 'base64').toString('binary');
    const row = new Float32Array(raw.length);
    const scale = Number(scales[index]);
    for (let i = 0; i < raw.length; i += 1) {
      let value = raw.charCodeAt(i);
      if (value > 127) value -= 256;
      row[i] = value * scale;
    }
    return row;
  });
}

function softmax(logits, temperature = 1) {
  const t = Math.max(0.05, Number(temperature) || 1);
  let maximum = -Infinity;
  for (const value of logits) maximum = Math.max(maximum, value / t);
  const probabilities = new Float64Array(logits.length);
  let total = 0;
  for (let i = 0; i < logits.length; i += 1) {
    probabilities[i] = Math.exp(logits[i] / t - maximum);
    total += probabilities[i];
  }
  for (let i = 0; i < probabilities.length; i += 1) probabilities[i] /= total || 1;
  return probabilities;
}

export function createRegisterStudent(model) {
  if (!model || model.schema !== 'archie-register-student-linear/v1') throw new Error('Invalid Archie register student model');
  const vocabulary = new Map(model.vocabulary.map((feature, index) => [feature, index]));
  const idf = Float32Array.from(model.idf);
  const weights = decodeInt8Rows(model.weights_int8.rows, model.weights_int8.scales);
  const bias = Float64Array.from(model.bias);
  const classes = [...model.classes];

  function infer(request) {
    const counts = new Map();
    for (const feature of registerStudentFeatures(request)) {
      const index = vocabulary.get(feature);
      if (index !== undefined) counts.set(index, (counts.get(index) || 0) + 1);
    }
    const values = [];
    let norm = 0;
    for (const [index, count] of counts) {
      const value = Math.log1p(count) * idf[index];
      values.push([index, value]);
      norm += value * value;
    }
    norm = Math.sqrt(norm) || 1;
    const logits = new Float64Array(classes.length);
    for (let output = 0; output < classes.length; output += 1) {
      let value = bias[output];
      const row = weights[output];
      for (const [index, raw] of values) value += row[index] * (raw / norm);
      logits[output] = value;
    }
    const probabilities = softmax(logits, model.temperature);
    let best = 0;
    for (let i = 1; i < probabilities.length; i += 1) if (probabilities[i] > probabilities[best]) best = i;
    const order = Array.from(probabilities.keys()).sort((a, b) => probabilities[b] - probabilities[a]);
    const margin = probabilities[order[0]] - probabilities[order[1] ?? order[0]];
    return {
      route: classes[best],
      confidence: probabilities[best],
      margin,
      recognized: counts.size,
      alternatives: order.slice(0, 3).map(index => ({ route: classes[index], confidence: probabilities[index] })),
      distribution: classes.map((route, index) => ({ route, p: probabilities[index] })).sort((a, b) => b.p - a.p),
    };
  }

  return { infer, classes, model };
}

export function registerAuthority(request) {
  const text = normalizeText(request);
  if (SAFE_DOCUMENTATION.test(text)) return { authority: 'allow', reason: 'fail-closed-safe-documentation' };
  if ((DANGEROUS.test(text) || (UNSAFE_OPERATION.test(text) && UNSAFE_TARGET.test(text) && AUTHORIZATION_GAP.test(text)))) {
    return { authority: 'deny', reason: 'fail-closed-operation-target-authorization' };
  }
  return { authority: 'allow', reason: 'no-denial-evidence' };
}

function referenceType(request) {
  const text = normalizeText(request);
  if (AMBIGUOUS_REFERENCE.test(text)) return 'ambiguous';
  if (ATTACHMENT_REFERENCE.test(text)) return 'attachment';
  if (MEMORY_REFERENCE.test(text)) return 'memory';
  if (THREAD_REFERENCE.test(text)) return 'thread';
  if (GENERIC_REFERENCE.test(text) && registerStudentTokens(text).length <= 9 && /^(?:please\s+)?(?:do|apply|use|handle|continue|fix|take care of)\b/i.test(text.trim())) return 'generic_unresolved';
  return 'none';
}

function payloadFor(context, type) {
  if (type === 'attachment') return context?.attachments;
  if (type === 'memory') return context?.memory;
  if (type === 'thread') return context?.thread;
  return '';
}

export function registerContext(request, context = {}) {
  const type = referenceType(request);
  if (type === 'ambiguous' || type === 'generic_unresolved') return { context: 'ambiguous', reference: type, support: 'unresolved' };
  if (type === 'attachment' || type === 'memory' || type === 'thread') {
    const payload = String(payloadFor(context, type) || '').trim();
    if (!payload) return { context: 'missing', reference: type, support: 'absent' };
    if (UNUSABLE_PAYLOAD.test(payload) || !USABLE_PAYLOAD.test(payload)) return { context: 'missing', reference: type, support: 'present-but-unusable' };
    return { context: 'ready', reference: type, support: 'usable' };
  }
  return { context: 'ready', reference: 'none', support: 'not-required' };
}

const ACTION_LEAD = '(?:draft|compose|write|prepare|summar(?:ize|ise)|condense|brief|extract|compare|choose|decide|select|plan|map|outline|schedule|organize|coordinate|check|verify|define|set|identify|pick|rank|build|construct|return|produce|convert|make|form|supply|adjudicate|settle|resolve|design|assemble|lay out|calculate|order|optimize|arrange|declare|formalize|state|lock|reduce|turn|give|create|enumerate|express|shape|surface|name|tell|structure|record|work out|track|sequence|break|set up|evaluate)';

function stripRegisterWrapper(value) {
  let text = String(value || '').trim();
  const prefixes = [
    /^(?:using\s+(?:the\s+)?(?:enclosed dossier|submitted workbook|provided evidence bundle|uploaded case file|attached|attachment|uploaded|appendix|exhibit)|ground the answer in (?:the )?(?:source packet|evidence attachment|uploaded ledger|supplied brief) while you),?\s*/i,
    /^(?:apply\s+(?:my|our|the)\s+(?:saved decision boundary|remembered operating constraint|persistent preference|long-lived priority|stored instruction|durable context)\s+while you|honor my (?:standing rule|saved constraint|remembered boundary|durable preference) as you)\s*/i,
    /^(?:extend\s+(?:the\s+)?(?:preceding analysis|earlier conclusion|conversation-so-far result|prior comparison)\s+and|build from the (?:earlier finding|prior result|preceding comparison|conversation conclusion) and)\s*/i,
    /^for the operating review,?\s*/i,
    /^for the duty officer,?\s*/i,
    /^as an operator handoff,?\s*/i,
    /^keep unsupported assumptions out and\s*/i,
    /^the output must be deployable:\s*/i,
    /^for the control-room review,?\s*/i,
    /^use direct operational language and\s*/i,
    /^without adding unsupported material,?\s*/i,
    /^the team has limited attention;?\s*/i,
    /^using plain language,?\s*/i,
    /^treat this as a real handoff and\s*/i,
    /^i need a usable artifact now:\s*/i,
  ];
  for (let pass = 0; pass < 4; pass += 1) {
    const before = text;
    for (const prefix of prefixes) text = text.replace(prefix, '');
    text = text.trim();
    if (text === before) break;
  }
  return text;
}

function bestActivePrediction(prediction) {
  if (ACTIVE_ROUTES.includes(prediction.route)) return prediction;
  const active = (prediction.distribution || []).find(item => ACTIVE_ROUTES.includes(item.route));
  return active ? { ...prediction, route: active.route, confidence: active.p, rescued_from: prediction.route } : prediction;
}

export function splitRegisterClauses(request) {
  let text = String(request || '').replace(/\s+/g, ' ').trim();
  const correction = text.match(CORRECTION);
  if (correction) text = correction[1].trim();
  const wrapperLead = '(?:for the operating review|without adding unsupported material|the team has limited attention|using plain language|treat this as a real handoff|i need a usable artifact now|for the duty officer|as an operator handoff|keep unsupported assumptions out and|the output must be deployable|for the control-room review|use direct operational language and|using (?:the )?(?:enclosed dossier|submitted workbook|provided evidence bundle|uploaded case file)|apply (?:my|our|the)|extend (?:the )?|ground the answer in|honor my|build from the)';
  const before = text.match(new RegExp(`^before(?: you)?\\s+(.+),\\s*(?:first\\s+)?(${wrapperLead}.+)$`, 'i'));
  if (before) return [stripRegisterWrapper(before[2]), stripRegisterWrapper(before[1])].filter(Boolean);
  text = stripRegisterWrapper(text);
  const sharedVerb = text.match(/^(create|make|prepare|write|draft|produce|build|form|supply)\s+(.+?)\s+and\s+((?:a|an|the)\s+.+)$/i);
  if (sharedVerb) {
    const verb = sharedVerb[1];
    return [stripRegisterWrapper(`${verb} ${sharedVerb[2]}`), stripRegisterWrapper(`${verb} ${sharedVerb[3]}`)].filter(Boolean);
  }
  const patterns = [
    /\s*;\s*carry out only\s*/i,
    /\s+once that is complete,?\s*/i,
    /\s*(?:;|,|—|-)\s*(?:and\s+)?(?:only after that|after that|afterward|next|following completion|upon completion|followed by|subsequently|and then|then|also)\s*:?[ ]*/i,
    /\s+(?:and\s+)?(?:afterward|following completion|upon completion|followed by|subsequently)\s*:?[ ]*/i,
    /\.\s*(?:after that|afterward|next|then|once that is complete|upon completion|following completion)\s*,?\s*/i,
    new RegExp(`\\s*(?:;|,)\\s*(?:also\\s+|and\\s+)?(?=${ACTION_LEAD}\\b)`, 'i'),
    /\s+(?:plus|as well as|along with|while also)\s+/i,
    new RegExp(`\\s+and,?\\s*(?:if [^,]+,\\s*)?(?=${ACTION_LEAD}\\b)`, 'i'),
  ];
  for (const pattern of patterns) {
    const parts = text.split(pattern).map(part => stripRegisterWrapper(part.replace(/^[,.;—-]+|[,.;—-]+$/g, ''))).filter(Boolean);
    if (parts.length > 1) return parts.slice(0, 4);
  }
  return [stripRegisterWrapper(text)];
}

export function isNegatedRegisterClause(clause) {
  return NEGATED_PREFIX.test(String(clause || '').trim());
}

export function createRegisterStudentController(model) {
  const student = createRegisterStudent(model);
  function predict(request, context = {}) {
    const authority = registerAuthority(request);
    const contextResult = registerContext(request, context);
    if (authority.authority === 'deny') {
      return { route: 'clarify', authority: 'deny', context: contextResult.context, outcomes: [], confidence: 1, decision_source: authority.reason, ...contextResult };
    }
    if (RAW_SOURCE.test(String(request || '')) && String(request || '').length > 60) {
      return { route: 'clarify', authority: 'allow', context: 'ambiguous', outcomes: [], confidence: 1, decision_source: 'fail-closed-raw-source', reference: contextResult.reference, support: contextResult.support };
    }
    if (CONTRAST_CLARIFY.test(String(request || '')) || CLARIFY_EXACT.test(String(request || '').trim()) || CLARIFY_NEGATIVE.test(String(request || '').trim()) || UNDERSPECIFIED_ARTIFACT.test(String(request || '').trim())) {
      return { route: 'clarify', authority: 'allow', context: 'ambiguous', outcomes: [], confidence: 1, decision_source: 'fail-closed-explicit-clarify', reference: contextResult.reference, support: contextResult.support };
    }
    if (contextResult.context !== 'ready') {
      return { route: 'clarify', authority: 'allow', context: contextResult.context, outcomes: [], confidence: 1, decision_source: 'fail-closed-reference', reference: contextResult.reference, support: contextResult.support };
    }
    const rawClauses = splitRegisterClauses(request);
    const hadNegatedClauses = rawClauses.some(clause => isNegatedRegisterClause(clause));
    const clauses = rawClauses.filter(clause => !isNegatedRegisterClause(clause));
    const safeDocumentationRoute = value => {
      const safeText = normalizeText(value);
      return /(?:verification tests?|non-destructive tests?|checklist|binary controls?|binary gates?|acceptance (?:criteria|controls?|gates?)|pass[ -]?fail (?:criteria|controls?|gates?))/i.test(safeText) ? 'checklist' : /(?:explain|summarize|why|safe custody|prohibition)/i.test(safeText) ? 'summary' : 'plan';
    };
    if (clauses.length === 1 && SAFE_DOCUMENTATION.test(String(request || ''))) {
      const route = safeDocumentationRoute(request);
      return { route, authority: 'allow', context: 'ready', outcomes: [route], confidence: 1, decision_source: 'fail-closed-safe-documentation-route', reference: contextResult.reference, support: contextResult.support };
    }
    if (!clauses.length) return { route: 'clarify', authority: 'allow', context: 'ambiguous', outcomes: [], confidence: 1, decision_source: 'all-clauses-negated', reference: contextResult.reference, support: contextResult.support };
    const whole = student.infer(request);
    const clausePredictions = clauses.map(clause => SAFE_DOCUMENTATION.test(clause) ? { ...student.infer(clause), route: safeDocumentationRoute(clause), confidence: 1, recognized: Math.max(2, student.infer(clause).recognized), decision_source: 'fail-closed-safe-documentation-route' } : bestActivePrediction(student.infer(clause)));
    const activeOutcomes = clausePredictions.map(item => item.route).filter(route => ACTIVE_ROUTES.includes(route));
    const distinct = [...new Set(activeOutcomes)];
    const compoundEvidence = clauses.length > 1 && activeOutcomes.length > 1 && distinct.length > 1;
    if (compoundEvidence) {
      return {
        route: 'compound', authority: 'allow', context: 'ready', outcomes: activeOutcomes,
        confidence: Math.min(whole.confidence, ...clausePredictions.map(item => item.confidence)),
        decision_source: 'learned-register-compound', reference: contextResult.reference, support: contextResult.support,
        alternatives: whole.alternatives,
      };
    }
    const explicitCompoundSyntax = /(?:;\s*also\b|\band then\b|\band afterward\b|\bafterward\b|\bafter that\b|\bonly after that\b|\bfollowing completion\b|\bupon completion\b|\bfollowed by\b|\bsubsequently\b|\bplus\b|\bas well as\b|\balong with\b)/i.test(String(request || ''));
    if (clauses.length === 1 && whole.route === 'compound' && explicitCompoundSyntax && !hadNegatedClauses) {
      const inferred = whole.distribution.filter(item => ACTIVE_ROUTES.includes(item.route)).slice(0, 2).map(item => item.route);
      return { route: 'compound', authority: 'allow', context: 'ready', outcomes: inferred, confidence: whole.confidence, decision_source: 'learned-register-whole-compound', reference: contextResult.reference, support: contextResult.support, alternatives: whole.alternatives };
    }
    const selected = clauses.length === 1 ? clausePredictions[0] : bestActivePrediction(whole);
    const route = selected.route;
    if (!ACTIVE_ROUTES.includes(route) || selected.recognized < 2 || selected.confidence < 0.015) {
      return { route: 'clarify', authority: 'allow', context: 'ambiguous', outcomes: [], confidence: selected.confidence, decision_source: 'learned-register-abstention', reference: contextResult.reference, support: contextResult.support, alternatives: selected.alternatives };
    }
    return { route, authority: 'allow', context: 'ready', outcomes: [route], confidence: selected.confidence, decision_source: 'learned-register-route', reference: contextResult.reference, support: contextResult.support, alternatives: selected.alternatives };
  }
  return { predict, infer: student.infer, model };
}

export function createRegisterAwareStudentRouter(baseRouter, model, protocols = {}) {
  if (typeof baseRouter !== 'function') throw new TypeError('baseRouter must be a function');
  const controller = createRegisterStudentController(model);
  return function infer(prompt) {
    const base = baseRouter(prompt) || { route: 'clarify', confidence: 0 };
    const learned = controller.predict(prompt, {});
    const minimumConfidence = Number(model.thresholds?.override_confidence || 0.38);
    const minimumMargin = Number(model.thresholds?.override_margin || 0.02);
    const raw = controller.infer(prompt);
    const shouldFallback = learned.authority === 'allow' && learned.context === 'ready' && learned.route !== 'clarify' && raw.confidence < minimumConfidence && raw.margin < minimumMargin;
    const route = shouldFallback ? base.route : learned.route;
    if (route === base.route) return { ...base, decision_source: shouldFallback ? 'model:base-low-register-confidence' : learned.decision_source, authority: learned.authority, context: learned.context, outcomes: learned.outcomes };
    const alternatives = [
      { route, confidence: learned.confidence },
      ...(base.alternatives || [{ route: base.route, confidence: base.confidence || 0 }]).filter(item => item.route && item.route !== route),
    ].slice(0, 3);
    return {
      ...base,
      route,
      protocol: protocols[route] || model.route_protocol?.[route] || base.protocol,
      confidence: learned.confidence,
      alternatives,
      decision_source: learned.decision_source,
      base_route: base.route || null,
      authority: learned.authority,
      context: learned.context,
      outcomes: learned.outcomes,
    };
  };
}
