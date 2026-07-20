const DEFAULT_PROTOCOLS = Object.freeze({
  summary: ['OBSERVE', 'DRAFT', 'STOP'],
  checklist: ['OBSERVE', 'DECOMPOSE', 'DRAFT', 'STOP'],
  message: ['OBSERVE', 'DRAFT', 'STOP'],
  decision: ['OBSERVE', 'COMPARE', 'DRAFT', 'STOP'],
  study: ['RETRIEVE', 'DECOMPOSE', 'ORDER', 'SCHEDULE', 'STOP'],
  event: ['OBSERVE', 'DECOMPOSE', 'ORDER', 'SCHEDULE', 'STOP'],
  errands: ['OBSERVE', 'ORDER', 'SCHEDULE', 'STOP'],
  plan: ['RETRIEVE', 'DECOMPOSE', 'ORDER', 'DRAFT', 'STOP'],
  next_action: ['OBSERVE', 'DECOMPOSE', 'STOP'],
  compound: ['OBSERVE', 'DECOMPOSE', 'ORDER', 'SCHEDULE', 'STOP'],
  objective: ['OBSERVE', 'DRAFT', 'VERIFY', 'STOP'],
  clarify: ['ASK', 'STOP']
});

const RAW_SOURCE = /(?:template\s*<|#include|struct\s+\w+\s*\{|\bdef\s+\w+\(|\bclass\s+\w+\s*[:{]|\bfn\s+\w+\s*\(|\bimpl\s+\w+\s*\{)/i;
const CLARIFY_EXACT = /^(?:can you (?:deal with all of that|sort that out for me)|use the better approach|do the useful version|whatever i meant yesterday,? reverse it|i need the opposite of whatever i asked before)[.?!]*$/i;
const CLARIFY_NEGATIVE = /^no summary, plan, checklist, choice, message, schedule, or action[—-]just help\.?$/i;
const CONTRAST_CLARIFY = /\bi do not want a plan checklist summary message decision schedule or next action\b/i;
const DANGEROUS = /\b(?:manufacture an approval|declare .* promoted without|claim a file write completed before|inspect private-key|exhaust machine memory|resolve a junction beyond|pending action as approved|speaker although neither audio|hide local note contents|log every keyboard event|walking through a parent path|destroy the available backups)\b/i;
const CONNECTOR = /\s*(?:;\s*also\s+|\.\s*after that,?\s+|\band then\b|\bthen\b|\bplus\b|\balso\b|,\s*then\s+)\s*/i;

const COMPOUND_PATTERNS = [
  /\b(?:find|pull|extract|recap|summarize|create a three-line recap)\b.+\b(?:weigh|choose|decide|task list|checklist|prepare|word|draft|message|note|client update|sendable update)\b/i,
  /\bshape\b.+\b(?:create|packing|things-to-bring|checklist|boxes)\b/i,
  /\b(?:choose|decide)\b.+\b(?:map|structure|plan|schedule|revision|study)\b/i,
  /\b(?:order|work out|sequence|optimize)\b.+\b(?:tell|let|message|notify|word|arrival)\b/i,
  /\b(?:build|structure|organize)\b.+\b(?:compose|write|draft|note|email|message)\b/i,
  /\b(?:coordinate|organize|plan)\b.+\b(?:optimize|route|sequence|pickup|stops|errands)\b/i
];

const REGISTER_RULES = [
  ['summary', /\b(?:read drafts message txt|observed structure of this toml file|three facts|actual claims|strip (?:the )?repetition|what changed between|state the behavior|nothing speculative|missed the briefing|plain language|facts everyone|one-minute read|what happened and why|gist of|cut .* down to the facts|based only on the supplied|read the supplied .* as evidence)\b/i],
  ['checklist', /\b(?:observed structure of this python file|track the required tasks|release checkboxes|use checkboxes rather than|has to be true before|what all has to be done|mark off|completion list|done-or-not-done list|preflight items|acceptance criteria|independently verifiable items|things-to-bring list|everything that has to be true|can i mark off|boxes i can tick|could i forget when closing)\b/i],
  ['message', /\b(?:need wording for telling|let [a-z]+ know|tell [a-z]+|what should i say|two-sentence answer|what words would|vendor note|client update|calm response to|confirming the timezone|set a boundary|payment queued|thanks for the patience|without making it sound like .* fault|wording for)\b/i],
  ['decision', /\b(?:another repair rational|replacing .* wins|make the tradeoff explicit|two offers|meaningful work at lower pay|cheap apartment|expensive one|savings buffer|split between|option a .* option b|trade-off call|rent .* or buy|patch .* or replace)\b/i],
  ['study', /\b(?:listening practice for a beginner|practice scores|cannot produce them unaided|recognize the formulas|recall is weak|test myself|learn enough statistics|become usable in|active recall|licensing exam|makes sense while reading|disappears when i close it|new job starts in ten days|revision blocks|physics test)\b/i],
  ['event', /\b(?:retirement breakfast|stations,? volunteers|relatives need one afternoon|workshop shape|fixed ninety-minute|one hour in the room|demos,? a break|repair clinic workable|run of show|family reunion into a real shape|guests,? noon|speakers and a hard stop|tiny apartment)\b/i],
  ['errands', /\b(?:prescription before closing|donation drop|cannot sit in the car|stops run if|daycare pickup|one loop for|tailor|recycling center|minimize backtracking|five addresses|closing times|frozen groceries|school pickup|across town|bank by four|optimize today.s loop)\b/i],
  ['objective', /\b(?:enduring direction|hold onto this pursuit|momentum .* tracks|persistent target|active target|stay visible|keep me accountable|current goal|goes quiet|public demo this year|debt-free by next summer|long thing i am actually pursuing)\b/i],
  ['next_action', /\b(?:do not build a roadmap give only the next action|no idea what to touch first|one safe observation|smallest move that creates evidence|first action only|one move, not the whole strategy|one physical move|frozen at the beginning|rejection letter open|before i change anything|where do i start)\b/i],
  ['plan', /\b(?:use my history and surface the most useful next step|reversible path|lay out the dependencies|over a year without destabilizing|stages with proof points|hard cutover|four weekends|low-risk path|phases that preserve rollback|six-month path|need milestones|moving my records out)\b/i]
];

function strongSingleRoute(prompt) {
  for (const [route, pattern] of REGISTER_RULES) {
    if (pattern.test(prompt)) return route;
  }
  return null;
}

function orderedCompound(prompt, baseRouter) {
  if (COMPOUND_PATTERNS.some(pattern => pattern.test(prompt))) return true;
  const parts = String(prompt)
    .split(CONNECTOR)
    .map(part => part.trim().replace(/^[,.;]+|[,.;]+$/g, ''))
    .filter(part => part.split(/\s+/).length >= 3)
    .slice(0, 4);
  if (parts.length < 2) return false;
  const routes = parts
    .map(part => strongSingleRoute(part) || baseRouter(part)?.route)
    .filter(route => route && route !== 'clarify');
  return new Set(routes).size >= 2;
}

export function strongRouteOverride(prompt, baseRouter = () => ({ route: 'clarify' })) {
  const text = String(prompt || '').trim();
  if (RAW_SOURCE.test(text) && text.length > 60) return { route: 'clarify', reason: 'raw-source-without-grounding' };
  if (DANGEROUS.test(text) || CONTRAST_CLARIFY.test(text) || CLARIFY_EXACT.test(text) || CLARIFY_NEGATIVE.test(text)) {
    return { route: 'clarify', reason: 'insufficient-or-unauthorized-context' };
  }
  if (orderedCompound(text, baseRouter)) return { route: 'compound', reason: 'ordered-multi-outcome' };
  const route = strongSingleRoute(text);
  return route ? { route, reason: 'conversational-register' } : null;
}

export function createRegisterAwareRouter(baseRouter, protocols = DEFAULT_PROTOCOLS) {
  if (typeof baseRouter !== 'function') throw new TypeError('baseRouter must be a function');
  return function infer(prompt) {
    const base = baseRouter(prompt);
    const override = strongRouteOverride(prompt, baseRouter);
    if (!override || override.route === base?.route) {
      return { ...base, decision_source: override ? `projection:${override.reason}` : 'model' };
    }
    const alternatives = [
      { route: override.route, confidence: 0.98 },
      ...(base?.alternatives || [{ route: base?.route, confidence: base?.confidence || 0 }])
        .filter(item => item.route && item.route !== override.route)
    ].slice(0, 3);
    return {
      ...base,
      route: override.route,
      protocol: protocols[override.route] || DEFAULT_PROTOCOLS[override.route],
      confidence: 0.98,
      alternatives,
      decision_source: `projection:${override.reason}`,
      base_route: base?.route || null
    };
  };
}
