import crypto from 'node:crypto';

export const AIL_SCHEMA = 'archie-language/v1';
export const AIL_KINDS = Object.freeze([
  'world',
  'actor',
  'source',
  'fact',
  'belief',
  'goal',
  'protect',
  'grant',
  'capability',
  'hypothesis',
  'step',
  'verify',
  'learn',
  'halt',
  'presentation'
]);

const SEMANTIC_KINDS = new Set(AIL_KINDS.filter(kind => kind !== 'presentation'));
const EXECUTABLE_KINDS = new Set(['step', 'verify', 'learn', 'halt']);
const RESERVED_FIELDS = new Set(['kind', 'id']);
const ID_PATTERN = /^[a-z][a-z0-9._/-]{0,127}$/i;

function clean(value, limit = 200000) {
  return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

function stable(value) {
  return JSON.stringify(canonical(value));
}

function digest(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');
}

function lineError(lineNumber, message) {
  throw new Error(`AIL line ${lineNumber}: ${message}`);
}

function parseHeader(line, lineNumber) {
  const match = line.match(/^([a-z][a-z0-9_-]*)\s+([a-z][a-z0-9._/-]*)(?:\s+([\s\S]+))?$/i);
  if (!match) lineError(lineNumber, 'expected: <kind> <id> <json-object>.');
  const [, kind, id, payloadText = '{}'] = match;
  if (!AIL_KINDS.includes(kind)) lineError(lineNumber, `unsupported kind ${kind}.`);
  if (!ID_PATTERN.test(id)) lineError(lineNumber, `invalid id ${id}.`);
  let payload;
  try {
    payload = JSON.parse(payloadText);
  } catch (error) {
    lineError(lineNumber, `payload is not valid JSON: ${error.message}`);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) lineError(lineNumber, 'payload must be a JSON object.');
  for (const field of RESERVED_FIELDS) {
    if (Object.hasOwn(payload, field)) lineError(lineNumber, `payload field ${field} is reserved by AIL.`);
  }
  return Object.freeze({ ...canonical(payload), kind, id });
}

export function parseArchieLanguage(source) {
  const text = clean(source, 2_000_000);
  const lines = text.split(/\r?\n/);
  let versionSeen = false;
  const instructions = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith('#')) continue;
    if (!versionSeen) {
      if (line !== 'AIL/1') lineError(index + 1, 'first non-comment line must be AIL/1.');
      versionSeen = true;
      continue;
    }
    instructions.push(parseHeader(line, index + 1));
  }
  if (!versionSeen) throw new Error('AIL source is missing AIL/1.');
  return validateArchieProgram({ schema: AIL_SCHEMA, instructions });
}

export function printArchieLanguage(program) {
  const validated = validateArchieProgram(program);
  const rows = ['AIL/1'];
  for (const instruction of validated.instructions) {
    const { kind, id, ...payload } = instruction;
    rows.push(`${kind} ${id} ${stable(payload)}`);
  }
  return `${rows.join('\n')}\n`;
}

function arrayOfIds(value, field, owner) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${owner}.${field} must be an array.`);
  return [...new Set(value.map(item => clean(item, 128)).filter(Boolean))];
}

function requireText(instruction, field) {
  const value = clean(instruction[field], 20000);
  if (!value) throw new Error(`${instruction.kind} ${instruction.id} requires ${field}.`);
  return value;
}

function validateInstruction(instruction) {
  if (!instruction || typeof instruction !== 'object' || Array.isArray(instruction)) throw new Error('AIL instruction must be an object.');
  const kind = clean(instruction.kind, 40);
  const id = clean(instruction.id, 128);
  if (!AIL_KINDS.includes(kind)) throw new Error(`Unsupported AIL instruction kind: ${kind || '(missing)'}.`);
  if (!ID_PATTERN.test(id)) throw new Error(`Invalid AIL instruction id: ${id || '(missing)'}.`);
  const normalized = { ...canonical(instruction), kind, id };

  if (['fact', 'belief', 'goal', 'protect', 'hypothesis', 'verify', 'halt'].includes(kind)) {
    normalized.expr = requireText(normalized, 'expr');
  }
  if (['fact', 'belief', 'hypothesis'].includes(kind)) {
    normalized.evidence = arrayOfIds(normalized.evidence, 'evidence', `${kind} ${id}`);
  }
  if (kind === 'belief' || kind === 'hypothesis') {
    const confidence = Number(normalized.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error(`${kind} ${id} confidence must be between 0 and 1.`);
    normalized.confidence = confidence;
  }
  if (kind === 'goal') {
    const priority = Number(normalized.priority ?? 0);
    if (!Number.isFinite(priority)) throw new Error(`goal ${id} priority must be finite.`);
    normalized.priority = priority;
  }
  if (kind === 'grant') {
    normalized.actor = requireText(normalized, 'actor');
    normalized.capability = requireText(normalized, 'capability');
    normalized.scope = requireText(normalized, 'scope');
  }
  if (kind === 'capability') {
    normalized.operation = requireText(normalized, 'operation');
    normalized.effect = clean(normalized.effect || 'read', 80);
    if (!['read', 'local-write', 'external-write', 'irreversible'].includes(normalized.effect)) throw new Error(`capability ${id} has unsupported effect ${normalized.effect}.`);
  }
  if (kind === 'step') {
    normalized.operation = requireText(normalized, 'operation');
    normalized.after = arrayOfIds(normalized.after, 'after', `${kind} ${id}`);
    normalized.requires = arrayOfIds(normalized.requires, 'requires', `${kind} ${id}`);
    normalized.expect = Array.isArray(normalized.expect) ? normalized.expect.map(item => clean(item, 2000)).filter(Boolean) : [];
  }
  if (kind === 'verify') {
    normalized.after = arrayOfIds(normalized.after, 'after', `${kind} ${id}`);
    normalized.evidence = arrayOfIds(normalized.evidence, 'evidence', `${kind} ${id}`);
  }
  if (kind === 'learn') {
    normalized.from = arrayOfIds(normalized.from, 'from', `${kind} ${id}`);
    normalized.after = arrayOfIds(normalized.after, 'after', `${kind} ${id}`);
    normalized.skill = requireText(normalized, 'skill');
    normalized.outcome = clean(normalized.outcome || 'accepted', 80);
    if (!['accepted', 'rejected', 'partial'].includes(normalized.outcome)) throw new Error(`learn ${id} has unsupported outcome ${normalized.outcome}.`);
  }
  if (kind === 'halt') {
    normalized.after = arrayOfIds(normalized.after, 'after', `${kind} ${id}`);
  }
  if (kind === 'presentation') {
    normalized.shell = requireText(normalized, 'shell');
  }
  return Object.freeze(normalized);
}

function executionDependencies(instruction, byId) {
  const candidates = [
    ...(instruction.after || []),
    ...(instruction.kind === 'learn' ? instruction.from || [] : [])
  ];
  return [...new Set(candidates)].filter(id => EXECUTABLE_KINDS.has(byId.get(id)?.kind));
}

function detectCycle(graph) {
  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`AIL dependency cycle includes ${id}.`);
    visiting.add(id);
    for (const dependency of graph.get(id) || []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of graph.keys()) visit(id);
}

function semanticInstructions(instructions) {
  return instructions.filter(instruction => SEMANTIC_KINDS.has(instruction.kind));
}

export function validateArchieProgram(program) {
  if (program?.schema !== AIL_SCHEMA) throw new Error(`AIL schema must be ${AIL_SCHEMA}.`);
  if (!Array.isArray(program.instructions) || !program.instructions.length) throw new Error('AIL program requires instructions.');
  const instructions = program.instructions.map(validateInstruction);
  const byId = new Map();
  for (const instruction of instructions) {
    if (byId.has(instruction.id)) throw new Error(`Duplicate AIL id: ${instruction.id}.`);
    byId.set(instruction.id, instruction);
  }

  const references = [];
  for (const instruction of instructions) {
    const dependencies = [...(instruction.after || []), ...(instruction.requires || []), ...(instruction.evidence || []), ...(instruction.from || [])];
    for (const dependency of dependencies) references.push({ owner: instruction.id, dependency });
  }
  for (const { owner, dependency } of references) {
    if (!byId.has(dependency)) throw new Error(`${owner} references missing instruction ${dependency}.`);
  }

  const executionGraph = new Map(
    instructions
      .filter(instruction => EXECUTABLE_KINDS.has(instruction.kind))
      .map(instruction => [instruction.id, executionDependencies(instruction, byId)])
  );
  detectCycle(executionGraph);

  const capabilities = new Map(instructions.filter(item => item.kind === 'capability').map(item => [item.id, item]));
  const grants = new Map(instructions.filter(item => item.kind === 'grant').map(item => [item.id, item]));
  for (const step of instructions.filter(item => item.kind === 'step')) {
    const capability = capabilities.get(step.operation);
    if (!capability) throw new Error(`step ${step.id} operation must reference a capability id.`);
    if (['external-write', 'irreversible'].includes(capability.effect)) {
      const matchingGrant = (step.requires || []).map(id => grants.get(id)).find(grant => grant?.capability === capability.id);
      if (!matchingGrant) throw new Error(`step ${step.id} requires an explicit grant for ${capability.effect} capability ${capability.id}.`);
    }
  }

  const semantic = semanticInstructions(instructions);
  const body = {
    schema: AIL_SCHEMA,
    instructions,
    semantic_digest: digest({ schema: AIL_SCHEMA, instructions: semantic }),
    source_digest: digest({ schema: AIL_SCHEMA, instructions })
  };
  return Object.freeze(body);
}

export function compileArchieProgram(program) {
  const validated = validateArchieProgram(program);
  const instructions = validated.instructions;
  const byId = new Map(instructions.map(item => [item.id, item]));
  const executable = instructions.filter(item => EXECUTABLE_KINDS.has(item.kind));
  const pending = new Map(executable.map(item => [item.id, item]));
  const emitted = new Set();
  const schedule = [];
  while (pending.size) {
    const ready = [...pending.values()]
      .filter(item => executionDependencies(item, byId).every(id => emitted.has(id)))
      .sort((left, right) => left.id.localeCompare(right.id));
    if (!ready.length) throw new Error('AIL executable schedule could not be resolved.');
    for (const instruction of ready) {
      schedule.push(instruction);
      emitted.add(instruction.id);
      pending.delete(instruction.id);
    }
  }
  return Object.freeze({
    schema: 'archie-executable-plan/v1',
    semantic_digest: validated.semantic_digest,
    presentation: instructions.filter(item => item.kind === 'presentation'),
    world: instructions.filter(item => !EXECUTABLE_KINDS.has(item.kind) && item.kind !== 'presentation'),
    schedule,
    schedule_digest: digest(schedule)
  });
}

export function compareArchiePrograms(left, right) {
  const a = validateArchieProgram(left);
  const b = validateArchieProgram(right);
  return Object.freeze({
    same_semantics: a.semantic_digest === b.semantic_digest,
    same_source: a.source_digest === b.source_digest,
    left_semantic_digest: a.semantic_digest,
    right_semantic_digest: b.semantic_digest
  });
}
