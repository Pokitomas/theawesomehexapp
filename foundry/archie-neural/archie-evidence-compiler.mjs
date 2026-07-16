import crypto from 'node:crypto';
import { AIL_SCHEMA, validateArchieProgram } from './archie-language.mjs';

export const SOURCE_SCHEMA = 'archie-source-record/v1';
export const CLAIM_SCHEMA = 'archie-claim/v1';
export const GRAPH_SCHEMA = 'archie-evidence-graph/v1';

export const SOURCE_CLASSES = Object.freeze([
  'scholarly-work',
  'dataset',
  'software',
  'clinical-trial',
  'patent',
  'standard',
  'government-record',
  'journalism',
  'forum',
  'social',
  'web'
]);

export const CLAIM_RELATIONS = Object.freeze([
  'supports',
  'contradicts',
  'reproduces',
  'cites',
  'retracts',
  'supersedes',
  'derives-from',
  'discusses'
]);

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

function safeId(value, prefix) {
  const raw = clean(value, 128).toLowerCase().replace(/[^a-z0-9._/-]+/g, '-').replace(/^-+|-+$/g, '');
  const candidate = raw && /^[a-z]/.test(raw) ? raw : `${prefix}-${digest(value).slice(0, 16)}`;
  return candidate.slice(0, 128);
}

function finiteConfidence(value, fallback = 0.5) {
  const confidence = Number(value ?? fallback);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error('Claim confidence must be between 0 and 1.');
  return confidence;
}

function sourceConfidenceCap(sourceClass) {
  switch (sourceClass) {
    case 'social': return 0.35;
    case 'forum': return 0.45;
    case 'journalism': return 0.65;
    case 'web': return 0.55;
    case 'scholarly-work': return 0.82;
    case 'clinical-trial': return 0.88;
    case 'dataset': return 0.9;
    case 'government-record':
    case 'standard': return 0.92;
    case 'software':
    case 'patent': return 0.8;
    default: return 0.5;
  }
}

export function normalizeSourceRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Source record must be an object.');
  if (value.schema && value.schema !== SOURCE_SCHEMA) throw new Error(`Source schema must be ${SOURCE_SCHEMA}.`);
  const sourceClass = clean(value.source_class, 80);
  if (!SOURCE_CLASSES.includes(sourceClass)) throw new Error(`Unsupported source class: ${sourceClass || '(missing)'}.`);
  const uri = clean(value.uri, 4000);
  if (!uri) throw new Error('Source URI is required.');
  const retrievedAt = clean(value.retrieved_at, 100);
  if (!retrievedAt || Number.isNaN(Date.parse(retrievedAt))) throw new Error('Source retrieved_at must be an ISO date.');
  const bytesDigest = clean(value.bytes_digest || value.content_digest, 128).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(bytesDigest)) throw new Error('Source bytes_digest must be a SHA-256 hex digest.');
  const id = safeId(value.source_id || value.id || uri, 'source');
  if (!ID_PATTERN.test(id)) throw new Error(`Invalid source id: ${id}.`);
  const status = clean(value.status || 'current', 80);
  if (!['current', 'superseded', 'retracted', 'withdrawn', 'unknown'].includes(status)) throw new Error(`Unsupported source status: ${status}.`);
  return Object.freeze({
    schema: SOURCE_SCHEMA,
    source_id: id,
    source_class: sourceClass,
    uri,
    retrieved_at: new Date(retrievedAt).toISOString(),
    bytes_digest: bytesDigest,
    status,
    title: clean(value.title, 2000),
    authors: Array.isArray(value.authors) ? value.authors.map(item => clean(item, 500)).filter(Boolean) : [],
    published_at: value.published_at && !Number.isNaN(Date.parse(value.published_at)) ? new Date(value.published_at).toISOString() : null,
    version: clean(value.version, 300) || null,
    license: clean(value.license, 500) || null,
    identifiers: canonical(value.identifiers && typeof value.identifiers === 'object' && !Array.isArray(value.identifiers) ? value.identifiers : {}),
    metadata: canonical(value.metadata && typeof value.metadata === 'object' && !Array.isArray(value.metadata) ? value.metadata : {})
  });
}

export function normalizeClaim(value, sourcesById) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Claim must be an object.');
  if (value.schema && value.schema !== CLAIM_SCHEMA) throw new Error(`Claim schema must be ${CLAIM_SCHEMA}.`);
  const sourceId = safeId(value.source_id, 'source');
  const source = sourcesById.get(sourceId);
  if (!source) throw new Error(`Claim references missing source ${sourceId}.`);
  const text = clean(value.text, 50000);
  if (!text) throw new Error('Claim text is required.');
  const claimId = safeId(value.claim_id || value.id || `${sourceId}-${digest(text).slice(0, 16)}`, 'claim');
  const claimType = clean(value.claim_type || 'assertion', 80);
  if (!['metadata', 'observation', 'assertion', 'hypothesis', 'result', 'method'].includes(claimType)) throw new Error(`Unsupported claim type: ${claimType}.`);
  const requestedConfidence = finiteConfidence(value.confidence, 0.5);
  const confidence = Math.min(requestedConfidence, sourceConfidenceCap(source.source_class));
  const extraction = value.extraction && typeof value.extraction === 'object' && !Array.isArray(value.extraction) ? canonical(value.extraction) : {};
  if (!clean(extraction.method, 200)) throw new Error(`Claim ${claimId} requires extraction.method.`);
  const span = extraction.span && typeof extraction.span === 'object' && !Array.isArray(extraction.span) ? canonical(extraction.span) : null;
  if (claimType !== 'metadata' && !span && !clean(extraction.structured_field, 500)) {
    throw new Error(`Claim ${claimId} requires an exact source span or structured field.`);
  }
  return Object.freeze({
    schema: CLAIM_SCHEMA,
    claim_id: claimId,
    source_id: sourceId,
    claim_type: claimType,
    text,
    confidence,
    extraction: { ...extraction, span },
    qualifiers: canonical(value.qualifiers && typeof value.qualifiers === 'object' && !Array.isArray(value.qualifiers) ? value.qualifiers : {}),
    observed_at: value.observed_at && !Number.isNaN(Date.parse(value.observed_at)) ? new Date(value.observed_at).toISOString() : source.retrieved_at
  });
}

function normalizeEdge(value, claimsById) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Evidence edge must be an object.');
  const from = safeId(value.from, 'claim');
  const to = safeId(value.to, 'claim');
  const relation = clean(value.relation, 80);
  if (!claimsById.has(from) || !claimsById.has(to)) throw new Error(`Evidence edge references missing claim: ${from} -> ${to}.`);
  if (!CLAIM_RELATIONS.includes(relation)) throw new Error(`Unsupported evidence relation: ${relation}.`);
  if (from === to) throw new Error('Evidence edge cannot be self-referential.');
  return Object.freeze({ from, to, relation, confidence: finiteConfidence(value.confidence, 1) });
}

export function buildEvidenceGraph({ sources = [], claims = [], edges = [] } = {}) {
  const normalizedSources = sources.map(normalizeSourceRecord);
  const sourcesById = new Map();
  for (const source of normalizedSources) {
    if (sourcesById.has(source.source_id)) throw new Error(`Duplicate source id: ${source.source_id}.`);
    sourcesById.set(source.source_id, source);
  }
  const normalizedClaims = claims.map(value => normalizeClaim(value, sourcesById));
  const claimsById = new Map();
  for (const claim of normalizedClaims) {
    if (claimsById.has(claim.claim_id)) throw new Error(`Duplicate claim id: ${claim.claim_id}.`);
    claimsById.set(claim.claim_id, claim);
  }
  const normalizedEdges = edges.map(value => normalizeEdge(value, claimsById));
  const body = {
    schema: GRAPH_SCHEMA,
    sources: normalizedSources.sort((a, b) => a.source_id.localeCompare(b.source_id)),
    claims: normalizedClaims.sort((a, b) => a.claim_id.localeCompare(b.claim_id)),
    edges: normalizedEdges.sort((a, b) => stable(a).localeCompare(stable(b)))
  };
  return Object.freeze({ ...body, graph_digest: digest(body) });
}

function epistemicKind(source, claim, incomingEdges) {
  if (claim.claim_type === 'metadata') return 'fact';
  if (source.status !== 'current') return 'hypothesis';
  if (source.source_class === 'social' || source.source_class === 'forum') return 'belief';
  if (claim.claim_type === 'hypothesis') return 'hypothesis';
  if (incomingEdges.some(edge => edge.relation === 'contradicts' || edge.relation === 'retracts' || edge.relation === 'supersedes')) return 'hypothesis';
  return 'belief';
}

function sourceInstruction(source) {
  return Object.freeze({
    kind: 'source',
    id: source.source_id,
    uri: source.uri,
    source_class: source.source_class,
    retrieved_at: source.retrieved_at,
    bytes_digest: source.bytes_digest,
    status: source.status,
    title: source.title,
    identifiers: source.identifiers,
    version: source.version,
    license: source.license
  });
}

function claimInstruction(source, claim, incomingEdges) {
  const kind = epistemicKind(source, claim, incomingEdges);
  const support = incomingEdges.filter(edge => ['supports', 'reproduces'].includes(edge.relation)).map(edge => edge.from);
  const opposition = incomingEdges.filter(edge => ['contradicts', 'retracts', 'supersedes'].includes(edge.relation)).map(edge => edge.from);
  const provenance = {
    source_id: source.source_id,
    source_class: source.source_class,
    source_status: source.status,
    extraction: claim.extraction,
    observed_at: claim.observed_at,
    supports: support,
    opposition
  };
  if (kind === 'fact') {
    return Object.freeze({ kind, id: claim.claim_id, expr: claim.text, evidence: [source.source_id], provenance });
  }
  return Object.freeze({ kind, id: claim.claim_id, expr: claim.text, confidence: claim.confidence, evidence: [source.source_id], provenance });
}

export function compileEvidenceGraphToAIL(graph, { includePresentation = false } = {}) {
  const validated = graph?.schema === GRAPH_SCHEMA && graph.graph_digest
    ? buildEvidenceGraph(graph)
    : buildEvidenceGraph(graph || {});
  const sourceById = new Map(validated.sources.map(source => [source.source_id, source]));
  const incomingByClaim = new Map(validated.claims.map(claim => [claim.claim_id, []]));
  for (const edge of validated.edges) incomingByClaim.get(edge.to)?.push(edge);

  const instructions = [
    { kind: 'world', id: 'evidence-world', graph_digest: validated.graph_digest },
    ...validated.sources.map(sourceInstruction),
    ...validated.claims.map(claim => claimInstruction(sourceById.get(claim.source_id), claim, incomingByClaim.get(claim.claim_id) || []))
  ];

  const conflictClaims = validated.claims.filter(claim => (incomingByClaim.get(claim.claim_id) || []).some(edge => ['contradicts', 'retracts', 'supersedes'].includes(edge.relation)));
  for (const claim of conflictClaims) {
    const opposition = (incomingByClaim.get(claim.claim_id) || []).filter(edge => ['contradicts', 'retracts', 'supersedes'].includes(edge.relation));
    instructions.push({
      kind: 'verify',
      id: safeId(`adjudicate-${claim.claim_id}`, 'verify'),
      expr: `adjudicate current status of ${claim.claim_id}`,
      after: [],
      evidence: [claim.claim_id, ...opposition.map(edge => edge.from)],
      relations: opposition
    });
  }
  if (includePresentation) instructions.push({ kind: 'presentation', id: 'evidence-shell', shell: 'evidence explorer' });

  return validateArchieProgram({ schema: AIL_SCHEMA, instructions });
}
