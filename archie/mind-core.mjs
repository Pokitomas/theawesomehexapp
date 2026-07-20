const MODE_PROTOCOLS = Object.freeze({
  summary: ['OBSERVE', 'EXTRACT', 'DRAFT', 'STOP'],
  checklist: ['OBSERVE', 'DECOMPOSE', 'DRAFT', 'STOP'],
  message: ['OBSERVE', 'CONSTRAIN', 'DRAFT', 'STOP'],
  decision: ['OBSERVE', 'COMPARE', 'DRAFT', 'STOP'],
  study: ['RETRIEVE', 'DECOMPOSE', 'ORDER', 'SCHEDULE', 'STOP'],
  event: ['OBSERVE', 'DECOMPOSE', 'ORDER', 'SCHEDULE', 'STOP'],
  errands: ['OBSERVE', 'ORDER', 'SCHEDULE', 'STOP'],
  plan: ['OBSERVE', 'DECOMPOSE', 'ORDER', 'DRAFT', 'STOP'],
  next_action: ['OBSERVE', 'DECOMPOSE', 'STOP'],
  compound: ['OBSERVE', 'DECOMPOSE', 'ROUTE_EACH', 'ORDER', 'STOP'],
  objective: ['OBSERVE', 'DRAFT', 'VERIFY', 'STOP'],
  clarify: ['ASK', 'STOP']
});

const MODE_LABELS = Object.freeze({
  summary: 'Summary', checklist: 'Checklist', message: 'Message draft', decision: 'Decision aid',
  study: 'Study breakdown', event: 'Event plan', errands: 'Errand plan', plan: 'Short plan',
  next_action: 'Next action', compound: 'Handled in parts', objective: 'Objective', clarify: 'Grounding needed'
});

const MODE_PATTERNS = Object.freeze([
  ['summary', /\b(?:summari[sz]e|summary|recap|brief|gist|tl;?dr|key points?|what changed|extract the claims?)\b/i],
  ['checklist', /\b(?:checklist|check list|to[- ]?do|tasks? list|boxes? (?:to )?tick|acceptance criteria|preflight)\b/i],
  ['message', /\b(?:draft|write|word|reply|respond|text|email|message|tell|follow[- ]?up|what should i say)\b/i],
  ['decision', /\b(?:decide|decision|choose|compare|trade[- ]?off|pros? and cons?|which should|between .+ and .+|\bor\b)\b/i],
  ['study', /\b(?:study|exam|test|quiz|learn|practice|revision|homework|assignment|class|memorize|recall)\b/i],
  ['event', /\b(?:event|party|dinner|meeting|meetup|birthday|workshop|reunion|run of show)\b/i],
  ['errands', /\b(?:errands?|grocer(?:y|ies)|shopping|pick up|pickup|drop off|pharmacy|stops?|route around town)\b/i],
  ['objective', /\b(?:objective|goal|target|keep me accountable|track this|active pursuit)\b/i],
  ['next_action', /\b(?:next action|first step|where do i start|stuck|one move|only the next|what do i do first)\b/i],
  ['plan', /\b(?:plan|roadmap|milestones?|phases?|schedule|strategy|organize|break down|sequence)\b/i]
]);

const MODE_WORD = '(?:summary|recap|brief|plan|roadmap|checklist|check list|message|email|text|decision|comparison|schedule|study plan|event plan|errand plan|next action|first step|objective|goal)';
const CONNECTOR = /\s*(?:\n+|;|\.\s*(?=(?:then|next|after|also)\b)|,\s*(?:then|next|after that)\s+|\band then\b|\bthen\b|\bafter that\b|\bplus\b|\balso\b)\s*/i;
const RAW_SOURCE = /(?:template\s*<|#include|struct\s+\w+\s*\{|\bdef\s+\w+\(|\bclass\s+\w+\s*[:{]|\bfn\s+\w+\s*\(|\bimpl\s+\w+\s*\{)/i;

export function normalizeText(value) {
  return String(value || '').replace(/\r/g, '').normalize('NFKC').replace(/[\t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

export function tokenize(value) {
  return normalizeText(value).toLowerCase().replace(/[^a-z0-9\s'-]+/g, ' ').split(/\s+/).filter(Boolean);
}

function sentenceCase(value) {
  const text = normalizeText(value).replace(/^[,.;:\s]+|[,;:\s]+$/g, '');
  return text ? text[0].toUpperCase() + text.slice(1) : '';
}

function stripLead(value) {
  return normalizeText(value)
    .replace(/^(?:please\s+)?(?:archie[, :]*)?/i, '')
    .replace(/^(?:can|could|would) you\s+/i, '')
    .replace(/^(?:i need you to|i need|help me|handle|take care of)\s+/i, '')
    .trim();
}

export function splitRequestedClauses(value) {
  const source = stripLead(value);
  const parts = source.split(CONNECTOR).map(part => part.trim().replace(/^[,.;]+|[,.;]+$/g, '')).filter(Boolean);
  if (parts.length > 1) return parts.slice(0, 8);
  const commaParts = source.split(/,\s+(?=(?:draft|write|summari[sz]e|make|build|choose|compare|plan|schedule|tell|message|email|order|then)\b)/i)
    .map(part => part.trim()).filter(Boolean);
  return (commaParts.length > 1 ? commaParts : [source]).slice(0, 8);
}

export function detectMode(text) {
  const source = normalizeText(text);
  for (const [mode, pattern] of MODE_PATTERNS) if (pattern.test(source)) return mode;
  return null;
}

export function extractExcludedModes(text) {
  const source = normalizeText(text).toLowerCase();
  const excluded = new Set();
  const modeMap = [
    ['summary', /summar(?:y|ize)|recap|brief/], ['plan', /plan|roadmap|strategy/], ['checklist', /check ?list|to-do|tasks? list/],
    ['message', /message|email|text|reply/], ['decision', /decision|comparison|pros and cons/], ['study', /study plan|revision/],
    ['event', /event plan|run of show/], ['errands', /errand plan|route/], ['next_action', /next action|first step/], ['objective', /objective|goal/]
  ];
  const negatedSegments = source.match(new RegExp(`(?:do not|don't|dont|not|no|without|avoid|skip)\\s+(?:(?:make|give|write|create|do|produce|turn this into)\\s+)?(?:me\\s+)?(?:(?:a|an|any|another|the)\\s+)?${MODE_WORD}`, 'gi')) || [];
  for (const segment of negatedSegments) {
    for (const [mode, pattern] of modeMap) if (pattern.test(segment)) excluded.add(mode);
  }
  return [...excluded];
}

function detectAuthorityBoundary(text) {
  const source = normalizeText(text);
  const fabricatedCompletion = /\b(?:claim|say|state|mark|record|declare|pretend|make it look like)\b.{0,70}\b(?:sent|emailed|called|approved|completed|finished|uploaded|deleted|paid|booked|signed|verified|deployed|merged)\b.{0,50}\b(?:without|before|even if|though)\b/i;
  const credentialAccess = /\b(?:private key|seed phrase|password|credential|session cookie|auth token|keylog|log every keystroke|steal|exfiltrate)\b/i;
  const destructive = /\b(?:delete|destroy|wipe|erase)\b.{0,45}\b(?:backup|all files|history|evidence|logs?)\b/i;
  if (fabricatedCompletion.test(source)) return { code: 'fabricated-completion', message: 'I cannot claim an external action happened when this page did not perform or verify it.' };
  if (credentialAccess.test(source)) return { code: 'credential-or-surveillance', message: 'I cannot help capture credentials, private keys, or hidden input.' };
  if (destructive.test(source)) return { code: 'destructive-ambiguity', message: 'I will not turn an ambiguous request into irreversible deletion.' };
  return null;
}

function extractDeadline(text) {
  const match = normalizeText(text).match(/\b(today|tonight|tomorrow|this (?:morning|afternoon|evening|week|weekend)|next (?:week|month)|by [^,.!?;\n]+|before [^,.!?;\n]+|on (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i);
  return match ? match[0] : null;
}

function extractRecipient(text) {
  const source = normalizeText(text);
  const patterns = [
    /\b(?:message|text|email|write|tell|reply to|respond to|follow up with)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/,
    /\bto\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)(?:\s+that|\s+about|\s+saying|[,.:]|$)/
  ];
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function extractTone(text) {
  const match = normalizeText(text).match(/\b(?:make it|sound|tone:?|but)\s+(confident|friendly|warm|direct|professional|casual|firm|calm|brief|concise|not desperate|not pushy|not rude)\b/i);
  return match ? match[1].toLowerCase() : null;
}

function extractOptions(text) {
  const source = stripLead(text);
  const patterns = [
    /\bbetween\s+(.+?)\s+and\s+(.+?)(?:[?.!]|$)/i,
    /\bwhether\s+to\s+(.+?)\s+or\s+(.+?)(?:[?.!]|$)/i,
    /\b(?:choose|decide|compare)\s+(.+?)\s+(?:or|versus|vs\.?)\s+(.+?)(?:[?.!]|$)/i,
    /\b(.{3,70}?)\s+or\s+(.{3,70}?)(?:[?.!]|$)/i
  ];
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match) return [sentenceCase(match[1]), sentenceCase(match[2])];
  }
  return [];
}

function resolveLocalContext(prompt, context = {}) {
  const history = Array.isArray(context.history) ? context.history : [];
  const activeObjective = normalizeText(context.activeObjective);
  const vague = /\b(?:from before|like before|same thing|what we discussed|whatever i said|the earlier one)\b/i.test(prompt) || /^(?:please\s+)?(?:handle|do|fix|sort|use|continue)\s+(?:it|that|this|the thing)\b/i.test(prompt) || /^(?:it|that|this|the thing)[.!?]*$/i.test(prompt);
  const last = history[0];
  if (!vague) return { resolvedText: prompt, used: null, unresolved: false };
  if (last?.request) {
    return {
      resolvedText: `${prompt}\n\nPrevious local request: ${normalizeText(last.request)}\nPrevious local result: ${normalizeText(last.response || '').slice(0, 500)}`,
      used: 'previous-turn',
      unresolved: false
    };
  }
  if (activeObjective) return { resolvedText: `${prompt}\n\nActive local objective: ${activeObjective}`, used: 'active-objective', unresolved: false };
  return { resolvedText: prompt, used: null, unresolved: true };
}

function attachmentEvidence(attachments = []) {
  return attachments.slice(0, 5).map(file => ({
    name: normalizeText(file.name) || 'unnamed file',
    type: normalizeText(file.type) || 'unknown type',
    size: Number(file.size) || 0,
    text: typeof file.text === 'string' ? file.text.slice(0, 32000) : ''
  }));
}

export function analyzeRequest(prompt, context = {}) {
  const raw = normalizeText(prompt);
  const authority = detectAuthorityBoundary(raw);
  const resolved = resolveLocalContext(raw, context);
  const attachments = attachmentEvidence(context.attachments);
  const attachmentText = attachments.map(file => file.text).filter(Boolean).join('\n\n');
  const analysisText = [resolved.resolvedText, attachmentText].filter(Boolean).join('\n\n');
  const clauses = splitRequestedClauses(raw);
  const excludedModes = extractExcludedModes(raw);
  const clauseModes = clauses.map(clause => ({ clause, mode: detectMode(clause) })).filter(item => item.mode && !excludedModes.includes(item.mode));
  const requestedModes = [...new Set(clauseModes.map(item => item.mode))];
  const explicitMode = detectMode(raw);
  const compound = clauses.length > 1 && (requestedModes.length > 1 || clauses.some(clause => /\b(?:and then|then|also|plus|after)\b/i.test(clause)));
  const rawSourceWithoutTask = RAW_SOURCE.test(raw) && raw.length > 80 && !/\b(?:summari[sz]e|explain|review|debug|fix|extract|convert)\b/i.test(raw);
  const tooVague = raw.split(/\s+/).length < 4 || resolved.unresolved || /^(?:handle|do|fix|sort|use)\s+(?:it|that|this|the thing)[.!?]*$/i.test(raw);
  return {
    raw,
    resolvedText: analysisText,
    clauses,
    clauseModes,
    requestedModes,
    explicitMode,
    excludedModes,
    compound,
    authority,
    rawSourceWithoutTask,
    tooVague,
    contextUsed: resolved.used,
    attachments,
    deadline: extractDeadline(raw),
    recipient: extractRecipient(raw),
    tone: extractTone(raw),
    options: extractOptions(raw)
  };
}

function bestAllowedAlternative(modelInference, excluded) {
  const denied = new Set(excluded);
  const alternatives = Array.isArray(modelInference?.alternatives) ? modelInference.alternatives : [];
  return alternatives.find(item => item?.route && !denied.has(item.route))?.route || null;
}

export function chooseRoute(modelInference, analysis) {
  const modelRoute = modelInference?.mode || modelInference?.route || null;
  if (analysis.authority || analysis.rawSourceWithoutTask || analysis.tooVague) return { mode: 'clarify', source: analysis.authority ? `boundary:${analysis.authority.code}` : 'abstention' };
  if (analysis.compound || analysis.requestedModes.length > 1) return { mode: 'compound', source: 'ordered-multi-outcome' };
  if (analysis.explicitMode && !analysis.excludedModes.includes(analysis.explicitMode)) return { mode: analysis.explicitMode, source: 'explicit-language' };
  if (modelRoute && !analysis.excludedModes.includes(modelRoute)) return { mode: modelRoute, source: 'trained-model' };
  const alternative = bestAllowedAlternative(modelInference, analysis.excludedModes);
  if (alternative) return { mode: alternative, source: 'model-alternative-after-negation' };
  if (analysis.clauseModes[0]?.mode) return { mode: analysis.clauseModes[0].mode, source: 'clause-language' };
  return { mode: 'next_action', source: 'safe-default' };
}

function compactTopic(text) {
  const stop = new Set(['a','an','the','and','or','but','to','of','for','in','on','at','with','from','by','about','as','is','are','be','i','me','my','we','our','you','your','it','this','that','please','just','can','could','would','should','need','want']);
  const words = tokenize(stripLead(text)).filter(word => !stop.has(word));
  return sentenceCase(words.slice(0, 9).join(' ')) || 'the request';
}

function extractList(text) {
  const source = normalizeText(text).split(':').slice(1).join(':') || stripLead(text);
  return [...new Set(source.split(/\s*(?:\n|;|,|\band\b|\bthen\b)\s*/i)
    .map(item => item.replace(/^(?:go to|visit|stop at|pick up|buy|get|do)\s+/i, '').trim())
    .filter(item => item.length > 1 && item.length < 100))].slice(0, 8);
}

function attachmentSummary(analysis) {
  const readable = analysis.attachments.filter(file => file.text);
  if (!readable.length) return null;
  const text = readable.map(file => file.text).join('\n');
  const sentences = text.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/).map(sentenceCase).filter(sentence => sentence.length > 15);
  const terms = tokenize(analysis.raw).filter(word => word.length > 3 && !['summarize','summary','file','attached','attachment','this','that'].includes(word));
  const scored = sentences.map((sentence, index) => ({
    sentence,
    index,
    score: terms.reduce((total, term) => total + (sentence.toLowerCase().includes(term) ? 2 : 0), 0) + Math.max(0, 3 - index * 0.15)
  })).sort((a, b) => b.score - a.score).slice(0, 4).sort((a, b) => a.index - b.index);
  return scored.map(item => item.sentence);
}

function messageDraft(analysis, text) {
  const recipient = analysis.recipient;
  let body = stripLead(text)
    .replace(/^(?:do not|don't|dont)\s+(?:make|give|write|create)?\s*(?:a\s+)?(?:plan|summary|checklist|decision|schedule)[.!,;:\s-]*(?:just\s+)?/i, '')
    .replace(/^(?:just\s+)?(?:draft|write|word|message|text|email|tell|reply to|respond to|follow up with)\s+/i, '')
    .replace(recipient ? new RegExp(`^${recipient.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(?:that|about|saying)?\\s*`, 'i') : /$^/, '')
    .replace(/\b(?:make it|sound|tone:?)\s+(?:confident|friendly|warm|direct|professional|casual|firm|calm|brief|concise|not desperate|not pushy|not rude)\b/ig, '')
    .trim();
  if (!body || body.length < 8) body = 'I wanted to follow up and check on the next step.';
  body = sentenceCase(body).replace(/[.?!]*$/, '.');
  const greeting = recipient ? `Hi ${recipient},` : 'Hi,';
  const closing = analysis.deadline ? `Please let me know whether ${analysis.deadline} works.` : 'Let me know what works best.';
  return `${greeting}\n\n${body}\n\n${closing}`;
}

function composeSingle(mode, text, analysis) {
  const topic = compactTopic(text);
  if (mode === 'summary') {
    const fileSummary = attachmentSummary(analysis);
    if (fileSummary?.length) return `Key points from the readable attachment${analysis.attachments.length > 1 ? 's' : ''}:\n\n${fileSummary.map((item, index) => `${index + 1}. ${item}`).join('\n')}`;
    const sentences = normalizeText(text).replace(/\n+/g, ' ').split(/(?<=[.!?])\s+/).map(sentenceCase).filter(Boolean).slice(0, 4);
    return sentences.length ? sentences.map((item, index) => `${index + 1}. ${item}`).join('\n') : 'Nothing grounded was provided to summarize.';
  }
  if (mode === 'checklist') {
    const direct = extractList(text);
    const items = direct.length > 1 ? direct : [`Define the finished outcome for ${topic.toLowerCase()}`, 'Gather the minimum information or materials needed', 'Complete the highest-impact part first', 'Check the result against the request', analysis.deadline ? `Close the loop ${analysis.deadline}` : 'Record what remains'];
    return items.map(item => `☐ ${sentenceCase(item).replace(/[.!]+$/, '')}`).join('\n');
  }
  if (mode === 'message') return messageDraft(analysis, text);
  if (mode === 'decision') {
    const [first = 'Option A', second = 'Option B'] = analysis.options;
    return `Compare ${first} against ${second}.\n\n1. Upside: what becomes possible?\n2. Cost: money, time, stress, and commitments.\n3. Reversibility: which choice preserves more future options?\n4. Evidence: what fact would make either option clearly win?\n\nProvisional call: prefer the more reversible option unless the other clearly protects safety, a hard deadline, or a commitment already made.`;
  }
  if (mode === 'study') return `Study target: ${topic}\n\n1. Attempt representative questions without notes.\n2. Mark misses by concept, not question number.\n3. Review only the weak concepts and explain each aloud.\n4. Retry fresh questions under time pressure.\n5. End with a one-page error sheet${analysis.deadline ? ` before ${analysis.deadline}` : ''}.`;
  if (mode === 'event') return `Event: ${topic}\n\n☐ Lock purpose, guest count, time, place, and budget\n☐ Assign one owner to each open decision\n☐ Confirm food, equipment, access, and backup plan\n☐ Write a simple run of show\n☐ Close with cleanup and follow-up ownership`;
  if (mode === 'errands') {
    const items = extractList(text);
    return `Run order\n\n${(items.length ? items : ['List every stop', 'Group stops by area', 'Put the time-sensitive stop first']).map((item, index) => `${index + 1}. ${sentenceCase(item)}`).join('\n')}\n\nKeep groceries, fragile items, and anything temperature-sensitive last. Check live hours before leaving.`;
  }
  if (mode === 'objective') return `Active objective: ${topic.replace(/[.!?]+$/, '')}.\n\nSuccess test:\n1. One concrete deliverable exists.\n2. Someone else can verify it without explanation.\n3. Any unfinished work has a named next step${analysis.deadline ? ` by ${analysis.deadline}` : ''}.`;
  if (mode === 'next_action') return `Next action: spend ten uninterrupted minutes producing the smallest visible piece of progress on “${topic}.”\n\nStop after that step exists, then reassess from what changed.`;
  return `1. Name the exact finished result for ${topic.toLowerCase()}.\n2. Gather only the inputs needed for the first move.\n3. Ship the smallest complete version.\n4. Verify it before expanding scope.\n5. Record the result, remaining gap, and next owner${analysis.deadline ? ` by ${analysis.deadline}` : ''}.`;
}

export function composeLocalResponse(prompt, modelInference = {}, context = {}) {
  const analysis = analyzeRequest(prompt, context);
  const decision = chooseRoute(modelInference, analysis);
  let response;
  if (decision.mode === 'clarify') {
    if (analysis.authority) response = `${analysis.authority.message}\n\nI can still help draft the truthful update, verification checklist, or next action. What result should actually exist?`;
    else if (analysis.rawSourceWithoutTask) response = 'I can see raw source-like text, but no grounded task. Say whether you want it explained, summarized, reviewed, debugged, or rewritten.';
    else response = analysis.contextUsed ? 'Which part of the previous local request should I continue, and what finished result should exist?' : 'What exact result should exist when this is done? Reply: “The finished result is ___, by ___, and do not ___.”';
  } else if (decision.mode === 'compound') {
    const parts = analysis.clauses.map((clause, index) => {
      const mode = detectMode(clause) || (index === 0 ? (modelInference?.mode || modelInference?.route || 'plan') : 'next_action');
      const safeMode = analysis.excludedModes.includes(mode) ? 'next_action' : mode;
      return `${index + 1}. ${MODE_LABELS[safeMode] || sentenceCase(safeMode)}\n${composeSingle(safeMode, clause, { ...analysis, options: extractOptions(clause), recipient: extractRecipient(clause), deadline: extractDeadline(clause) || analysis.deadline })}`;
    });
    response = parts.join('\n\n');
  } else response = composeSingle(decision.mode, analysis.raw, analysis);

  if (analysis.attachments.length && !analysis.attachments.some(file => file.text)) {
    response += `\n\nAttachment boundary: I received metadata for ${analysis.attachments.map(file => file.name).join(', ')}, but this browser build could not read those file contents.`;
  }
  const modelConfidence = Number(modelInference?.confidence ?? modelInference?.margin ?? 0);
  return {
    mode: decision.mode,
    title: MODE_LABELS[decision.mode] || 'Result',
    response,
    protocol: MODE_PROTOCOLS[decision.mode] || MODE_PROTOCOLS.clarify,
    route_source: decision.source,
    confidence: Number.isFinite(modelConfidence) ? modelConfidence : 0,
    analysis: {
      clauses: analysis.clauses,
      requested_modes: analysis.requestedModes,
      excluded_modes: analysis.excludedModes,
      context_used: analysis.contextUsed,
      attachment_count: analysis.attachments.length,
      authority_boundary: analysis.authority?.code || null
    }
  };
}

export function modeLabel(mode) {
  return MODE_LABELS[mode] || sentenceCase(String(mode || 'result').replace(/_/g, ' '));
}

export function protocolFor(mode) {
  return MODE_PROTOCOLS[mode] || MODE_PROTOCOLS.clarify;
}
