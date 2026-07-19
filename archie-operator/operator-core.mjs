const STOP_WORDS = new Set([
  'a','an','the','and','or','but','to','of','for','in','on','at','with','from','by','about','as','is','are','be','been','being',
  'i','me','my','we','our','you','your','it','this','that','these','those','please','just','can','could','would','should','need','want'
]);

export function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s'-]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

export function featureStrings(text, charNgrams = false) {
  const words = tokenize(text);
  const features = words.map(word => `w:${word}`);
  for (let index = 0; index < words.length - 1; index += 1) {
    features.push(`b:${words[index]}_${words[index + 1]}`);
  }
  if (charNgrams) {
    for (const word of words) {
      const marked = `^${word}$`;
      for (let index = 0; index + 3 <= marked.length; index += 1) {
        features.push(`c:${marked.slice(index, index + 3)}`);
      }
    }
  }
  return features;
}

export function decodeInt8(rows, scales) {
  return rows.map((encoded, index) => {
    const raw = typeof atob === 'function'
      ? atob(encoded)
      : Buffer.from(encoded, 'base64').toString('binary');
    const output = new Float32Array(raw.length);
    for (let offset = 0; offset < raw.length; offset += 1) {
      let value = raw.charCodeAt(offset);
      if (value > 127) value -= 256;
      output[offset] = value * scales[index];
    }
    return output;
  });
}

export function createRouter(model) {
  if (!model?.weights_int8 || !model?.dims) throw new Error('Invalid Archie route model');
  const firstLayer = decodeInt8(model.weights_int8.W1.rows, model.weights_int8.W1.scales);
  const secondLayer = decodeInt8(model.weights_int8.W2.rows, model.weights_int8.W2.scales);
  const firstBias = model.weights_int8.b1;
  const secondBias = model.weights_int8.b2;
  const vocabulary = new Map(model.vocabulary.map((feature, index) => [feature, index]));
  const charNgrams = Boolean(model.config?.charNgrams);
  const routes = model.routes || model.intents;
  const protocols = model.route_protocol || model.intent_protocol;

  return function infer(prompt) {
    const vector = new Float32Array(model.dims.input);
    const counts = new Map();
    for (const feature of featureStrings(prompt, charNgrams)) {
      if (vocabulary.has(feature)) counts.set(feature, (counts.get(feature) || 0) + 1);
    }

    let norm = 0;
    for (const [feature, count] of counts) {
      const value = Math.log1p(count);
      vector[vocabulary.get(feature)] = value;
      norm += value * value;
    }
    norm = Math.sqrt(norm) || 1;
    for (let index = 0; index < vector.length; index += 1) vector[index] /= norm;

    const hidden = new Float32Array(model.dims.hidden);
    for (let unit = 0; unit < model.dims.hidden; unit += 1) {
      let value = firstBias[unit];
      const row = firstLayer[unit];
      for (let index = 0; index < model.dims.input; index += 1) value += row[index] * vector[index];
      hidden[unit] = Math.tanh(value);
    }

    const logits = new Float32Array(model.dims.classes);
    let maximum = -Infinity;
    for (let output = 0; output < model.dims.classes; output += 1) {
      let value = secondBias[output];
      const row = secondLayer[output];
      for (let unit = 0; unit < model.dims.hidden; unit += 1) value += row[unit] * hidden[unit];
      logits[output] = value;
      if (value > maximum) maximum = value;
    }

    const probabilities = new Float32Array(model.dims.classes);
    let total = 0;
    for (let output = 0; output < model.dims.classes; output += 1) {
      probabilities[output] = Math.exp(logits[output] - maximum);
      total += probabilities[output];
    }

    let best = 0;
    for (let output = 0; output < model.dims.classes; output += 1) {
      probabilities[output] /= total;
      if (probabilities[output] > probabilities[best]) best = output;
    }

    const route = routes[best];
    return {
      route,
      protocol: protocols[route] || ['OBSERVE', 'DRAFT', 'STOP'],
      confidence: probabilities[best],
      alternatives: Array.from(probabilities)
        .map((confidence, index) => ({ route: routes[index], confidence }))
        .sort((left, right) => right.confidence - left.confidence)
        .slice(0, 3)
    };
  };
}

function sentenceCase(text) {
  const cleaned = String(text || '').trim().replace(/\s+/g, ' ');
  return cleaned ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : '';
}

function stripLead(text) {
  return String(text || '')
    .trim()
    .replace(/^(please\s+|can you\s+|could you\s+|would you\s+|i need you to\s+|i need\s+|help me\s+|tell archie\s+)/i, '')
    .replace(/[.?!]+$/, '')
    .trim();
}

function compactTopic(prompt) {
  const words = tokenize(stripLead(prompt)).filter(word => !STOP_WORDS.has(word));
  const topic = words.slice(0, 8).join(' ');
  return topic ? sentenceCase(topic) : 'the request';
}

function clauses(prompt) {
  return stripLead(prompt)
    .split(/\s*(?:,|;|\bthen\b|\band then\b|\balso\b|\bplus\b|\bafter that\b)\s*/i)
    .map(part => part.trim())
    .filter(part => part.length > 2)
    .slice(0, 8);
}

function dedupe(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = item.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractDeadline(prompt) {
  const match = String(prompt).match(/\b(today|tonight|tomorrow|this (?:morning|afternoon|evening|week|weekend)|next (?:week|month)|by [^,.!?;]+|before [^,.!?;]+|on (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i);
  return match ? match[0] : null;
}

function extractRecipient(prompt) {
  const patterns = [
    /\b(?:[Mm]essage|[Tt]ext|[Ee]mail|[Ww]rite|[Tt]ell|[Rr]eply to|[Rr]espond to)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/,
    /\bto\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)(?:\s+that|\s+about|\s+saying|[,.:]|$)/
  ];
  for (const pattern of patterns) {
    const match = String(prompt).match(pattern);
    if (match) return match[1];
  }
  return null;
}

function extractOptions(prompt) {
  const source = stripLead(prompt);
  const between = source.match(/\bbetween\s+(.+?)\s+and\s+(.+?)(?:[?.!]|$)/i);
  if (between) return [sentenceCase(between[1]), sentenceCase(between[2])];
  const whether = source.match(/\bwhether\s+to\s+(.+?)\s+or\s+(.+?)(?:[?.!]|$)/i);
  if (whether) return [sentenceCase(whether[1]), sentenceCase(whether[2])];
  const choose = source.match(/\b(?:choose|decide)\s+(.+?)\s+or\s+(.+?)(?:[?.!]|$)/i);
  if (choose) return [sentenceCase(choose[1]), sentenceCase(choose[2])];
  const simple = source.match(/\b(.{3,60}?)\s+or\s+(.{3,60}?)(?:[?.!]|$)/i);
  return simple ? [sentenceCase(simple[1]), sentenceCase(simple[2])] : [];
}

function extractList(prompt) {
  const afterColon = String(prompt).split(':').slice(1).join(':');
  const source = afterColon || stripLead(prompt);
  return dedupe(source
    .split(/\s*(?:,|;|\band\b|\bthen\b)\s*/i)
    .map(item => item.replace(/^(?:go to|visit|stop at|pick up|buy|get|do)\s+/i, '').trim())
    .filter(item => item.length > 1 && item.length < 70))
    .slice(0, 8);
}

function titleFor(route) {
  const titles = {
    checklist: 'Checklist ready', clarify: 'One detail needed', compound: 'Sequence ready', decision: 'Decision frame',
    errands: 'Run ordered', event: 'Event runbook', message: 'Message drafted', next_action: 'Start here',
    objective: 'Objective locked', plan: 'Plan ready', study: 'Study sprint', summary: 'Brief ready'
  };
  return titles[route] || 'Response ready';
}

function baseResult(prompt, route, confidence, protocol) {
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    prompt: String(prompt).trim(),
    route,
    title: titleFor(route),
    confidence,
    protocol,
    createdAt: new Date().toISOString(),
    sections: [],
    plainText: ''
  };
}

function finalize(result) {
  const lines = [result.title];
  if (result.lead) lines.push('', result.lead);
  for (const section of result.sections) {
    lines.push('', section.heading);
    if (section.body) lines.push(section.body);
    if (section.items) section.items.forEach((item, index) => lines.push(`${index + 1}. ${item}`));
  }
  result.plainText = lines.join('\n').trim();
  return result;
}

function composeChecklist(prompt, result) {
  const topic = compactTopic(prompt);
  const direct = clauses(prompt).map(sentenceCase);
  const deadline = extractDeadline(prompt);
  const items = dedupe([
    ...direct,
    `Define the finished state for ${topic.toLowerCase()}`,
    'Gather the minimum information or materials needed',
    'Complete the highest-impact part first',
    'Check the result against the original request',
    deadline ? `Close the loop ${deadline}` : 'Close the loop and record what remains'
  ]).slice(0, 7);
  result.lead = deadline ? `Built around the deadline: ${deadline}.` : `A checkable path for ${topic.toLowerCase()}.`;
  result.sections = [{ heading: 'Do in order', items }];
}

function composePlan(prompt, result) {
  const topic = compactTopic(prompt);
  const deadline = extractDeadline(prompt);
  result.lead = `A four-phase path for ${topic.toLowerCase()}${deadline ? `, anchored to ${deadline}` : ''}.`;
  result.sections = [
    { heading: '1 · Frame', items: [`State the outcome and non-negotiables for ${topic.toLowerCase()}`, 'Name the one condition that would make the plan fail'] },
    { heading: '2 · Prepare', items: ['Collect only the inputs required for the first move', 'Remove or schedule around the clearest blocker'] },
    { heading: '3 · Execute', items: ['Ship the smallest complete version', 'Verify it before expanding scope'] },
    { heading: '4 · Close', items: ['Record the result, remaining gap, and next owner', deadline ? `Confirm completion ${deadline}` : 'Set the next review point'] }
  ];
}

function composeNextAction(prompt, result) {
  const topic = compactTopic(prompt);
  const firstClause = clauses(prompt)[0];
  result.lead = firstClause
    ? `Open a note and write the exact finished state for “${sentenceCase(firstClause)}” in one sentence.`
    : `Write the finished state for ${topic.toLowerCase()} in one sentence.`;
  result.sections = [{ heading: 'Then', items: ['Spend ten uninterrupted minutes on the smallest irreversible-free step', 'Stop and reassess only after that step exists'] }];
}

function composeObjective(prompt, result) {
  const topic = compactTopic(prompt);
  const deadline = extractDeadline(prompt) || 'the next agreed review date';
  result.lead = `Complete ${topic.toLowerCase()} by ${deadline}, with a visible result another person can verify.`;
  result.sections = [
    { heading: 'Success test', items: ['One concrete deliverable exists', 'The deliverable can be checked without explanation', 'Any unfinished work has a named next step'] },
    { heading: 'Guardrail', body: 'Do not expand scope until the first measurable result is complete.' }
  ];
}

function composeMessage(prompt, result) {
  const recipient = extractRecipient(prompt);
  const deadline = extractDeadline(prompt);
  let content = stripLead(prompt)
    .replace(/^(?:message|text|email|write|draft|tell|reply to|respond to)\s+/i, '')
    .replace(new RegExp(`^${recipient ? recipient.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '$^'}\\s*(?:that|about|saying)?\\s*`, 'i'), '')
    .trim();
  if (!content || content.length < 8) content = 'I wanted to follow up and make sure we are aligned on the next step.';
  content = sentenceCase(content).replace(/[.?!]*$/, '.');
  const greeting = recipient ? `Hi ${recipient},` : 'Hi,';
  const closing = deadline ? `Please let me know whether ${deadline} works.` : 'Let me know what works best.';
  result.lead = `${greeting}\n\n${content}\n\n${closing}`;
  result.sections = [{ heading: 'Send as written', body: 'Clear, direct, and free of invented details.' }];
}

function composeDecision(prompt, result) {
  const options = extractOptions(prompt);
  const [first = 'Option A', second = 'Option B'] = options;
  result.lead = `Compare ${first.toLowerCase()} against ${second.toLowerCase()} using reversibility before preference.`;
  result.sections = [
    { heading: first, items: ['Best-case upside', 'Worst-case cost', 'How reversible the choice is', 'What must be true for this to win'] },
    { heading: second, items: ['Best-case upside', 'Worst-case cost', 'How reversible the choice is', 'What must be true for this to win'] },
    { heading: 'Provisional rule', body: 'Prefer the option that preserves future choices unless the less-reversible option has a clearly larger, evidence-backed upside.' }
  ];
}

function composeSummary(prompt, result) {
  const clean = stripLead(prompt);
  const parts = clauses(clean);
  result.lead = sentenceCase(clean.length > 220 ? `${clean.slice(0, 217)}…` : clean);
  result.sections = [
    { heading: 'Core ask', body: sentenceCase(parts[0] || clean) },
    { heading: 'Constraints detected', items: [extractDeadline(prompt) ? `Timing: ${extractDeadline(prompt)}` : 'No explicit deadline', parts.length > 1 ? `${parts.length} linked parts` : 'Single request'] },
    { heading: 'Next move', body: 'Confirm the desired output, then produce the smallest complete version.' }
  ];
}

function composeErrands(prompt, result) {
  const items = extractList(prompt);
  const ordered = items.length ? items : ['Define every stop', 'Group nearby stops', 'Do the time-sensitive stop first'];
  result.lead = 'Ordered without pretending to know live traffic or store hours.';
  result.sections = [
    { heading: 'Run order', items: ordered },
    { heading: 'Before leaving', items: ['Check hours for any time-sensitive stop', 'Bring every return, document, or reusable bag at once', 'Put cold or fragile items last'] }
  ];
}

function composeEvent(prompt, result) {
  const topic = compactTopic(prompt);
  const deadline = extractDeadline(prompt);
  result.lead = `A minimal runbook for ${topic.toLowerCase()}${deadline ? ` ${deadline}` : ''}.`;
  result.sections = [
    { heading: 'Lock first', items: ['Purpose and guest count', 'Time, place, and hard budget', 'One owner for each open decision'] },
    { heading: 'Prepare', items: ['Send the essential details', 'Confirm food, equipment, access, and backup plan', 'Write a simple run of show'] },
    { heading: 'Day of', items: ['Arrive early enough to fix one problem', 'Keep one person free for exceptions', 'Close with cleanup and follow-up ownership'] }
  ];
}

function composeStudy(prompt, result) {
  const topic = compactTopic(prompt);
  const deadline = extractDeadline(prompt);
  result.lead = `A recall-first study loop for ${topic.toLowerCase()}${deadline ? ` before ${deadline}` : ''}.`;
  result.sections = [
    { heading: 'Sprint 1 · Diagnose', items: ['Attempt representative questions without notes', 'Mark errors by concept, not by question number'] },
    { heading: 'Sprint 2 · Repair', items: ['Review only the weak concepts', 'Explain each concept aloud in plain language'] },
    { heading: 'Sprint 3 · Prove', items: ['Retry fresh problems under time pressure', 'Stop reviewing what you can already retrieve correctly'] },
    { heading: 'Final pass', body: 'Create a one-page error sheet and sleep instead of adding a new topic at the end.' }
  ];
}

function composeCompound(prompt, result) {
  const parts = clauses(prompt);
  const items = (parts.length ? parts : [stripLead(prompt)]).map((part, index) => `${index + 1 === parts.length ? 'Finish' : 'Handle'}: ${sentenceCase(part)}`);
  result.lead = 'The request contains multiple jobs. This sequence prevents them from collapsing into one vague task.';
  result.sections = [
    { heading: 'Sequence', items },
    { heading: 'Control point', body: 'Do not start the next part until the previous part has a visible result or a named blocker.' }
  ];
}

function composeClarify(prompt, result) {
  const clean = stripLead(prompt);
  result.lead = clean.length < 18
    ? 'What exact result should exist when this is done?'
    : 'Which matters most here: speed, quality, cost, or avoiding a specific risk?';
  result.sections = [
    { heading: 'Reply with one line', body: '“The finished result is ___, by ___, and do not ___.”' },
    { heading: 'Why Archie stopped', body: 'The request does not contain enough grounded detail to act without inventing context.' }
  ];
}

export function composeResponse(prompt, inference) {
  const route = inference?.route || 'clarify';
  const result = baseResult(prompt, route, inference?.confidence ?? 0, inference?.protocol || ['ASK', 'STOP']);
  const composers = {
    checklist: composeChecklist,
    clarify: composeClarify,
    compound: composeCompound,
    decision: composeDecision,
    errands: composeErrands,
    event: composeEvent,
    message: composeMessage,
    next_action: composeNextAction,
    objective: composeObjective,
    plan: composePlan,
    study: composeStudy,
    summary: composeSummary
  };
  (composers[route] || composeClarify)(prompt, result);
  return finalize(result);
}

export function routeLabel(route) {
  return String(route || 'clarify').replace(/_/g, ' ');
}

export function formatConfidence(confidence) {
  return `${Math.round(Math.max(0, Math.min(1, Number(confidence) || 0)) * 100)}%`;
}
