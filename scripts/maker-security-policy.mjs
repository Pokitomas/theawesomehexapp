import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';

const SCHEMA = 'sideways-maker-security-policy/v1';
const AUDIT_SCHEMA = 'sideways-maker-security-audit/v1';
const DECISION_SCHEMA = 'sideways-maker-security-decision/v1';
const GRANT_SCHEMA = 'sideways-maker-capability-grant/v1';
const ESCALATION_SCHEMA = 'sideways-maker-security-escalation/v1';
const TRUST_LEVELS = Object.freeze({ untrusted: 0, observed: 1, authenticated: 2, human: 3, control: 4 });
const ORIGINS = Object.freeze({
  human_command: { trust: 'human', instructions: true },
  control_plane: { trust: 'control', instructions: true },
  repository_content: { trust: 'untrusted', instructions: false },
  dependency: { trust: 'untrusted', instructions: false },
  issue_review: { trust: 'observed', instructions: false },
  model_output: { trust: 'untrusted', instructions: false },
  tool_output: { trust: 'untrusted', instructions: false },
  network_response: { trust: 'untrusted', instructions: false },
  artifact: { trust: 'untrusted', instructions: false },
  secret_store: { trust: 'control', instructions: false },
  worker_attestation: { trust: 'authenticated', instructions: false }
});
const HUMAN_ONLY = new Set([
  'github.repository.create', 'github.repository.delete', 'github.repository.settings', 'github.secret.write',
  'deploy.production', 'production.data.mutate', 'training.spend', 'authority.expand'
]);
const SECRET_KEY_RE = /(?:^|[_-])(token|secret|password|passwd|api[_-]?key|private[_-]?key|cookie|session|credential|authorization)(?:$|[_-])/i;
const SECRET_PATTERNS = Object.freeze([
  { id: 'github-classic-token', re: /\bgh[opusr]_[A-Za-z0-9]{20,}\b/g },
  { id: 'github-fine-grained-token', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { id: 'openai-like-key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { id: 'aws-access-key', re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { id: 'google-api-key', re: /\bAIza[A-Za-z0-9_-]{30,}\b/g },
  { id: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { id: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi },
  { id: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { id: 'database-url', re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s"'<>]+/gi }
]);
const PROMPT_INJECTION_PATTERNS = Object.freeze([
  /ignore (?:all |any )?(?:previous|prior|system|developer) instructions/i,
  /reveal|print|exfiltrate|upload|send (?:the )?(?:secret|token|credential|environment)/i,
  /you are now|new system prompt|override (?:the )?(?:policy|authority|goal)/i,
  /disable|bypass|remove (?:the )?(?:sandbox|safety|policy|human gate)/i,
  /run (?:this )?(?:curl|wget|powershell|bash|sh) .*https?:/i
]);
const BLOCKED_PATH_SEGMENTS = new Set(['.git', '.ssh', '.aws', '.gnupg', 'node_modules/.cache']);
const SECRET_BASENAME_RE = /^(?:\.env(?:\..*)?|id_(?:rsa|ed25519|ecdsa)|credentials?(?:\..*)?|.*\.(?:pem|p12|pfx|key))$/i;
const ARCHIVE_EXTENSIONS = new Set(['.zip', '.tar', '.tgz', '.gz', '.bz2', '.xz', '.7z', '.rar', '.jar', '.war']);
const SAFE_ENV_NAMES = new Set(['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'CI', 'NODE_ENV', 'NO_COLOR', 'LANG', 'LC_ALL', 'TZ']);
const ALLOWED_MIME_PREFIXES = ['text/', 'application/json', 'application/xml', 'application/rss+xml', 'application/atom+xml', 'application/octet-stream'];

const clean = (value, limit = 20000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
const nowISO = () => new Date().toISOString();
const sortedUnique = values => [...new Set(values)].sort();

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
}

export function stableJSONStringify(value) {
  return JSON.stringify(canonical(value));
}

export function digest(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : stableJSONStringify(value)).digest('hex');
}

function fingerprint(value) {
  return digest(String(value)).slice(0, 16);
}

function entropy(value) {
  const text = String(value);
  if (!text.length) return 0;
  const counts = new Map();
  for (const char of text) counts.set(char, (counts.get(char) || 0) + 1);
  let total = 0;
  for (const count of counts.values()) {
    const probability = count / text.length;
    total -= probability * Math.log2(probability);
  }
  return total;
}

function highEntropyCandidates(text) {
  const results = [];
  const re = /\b[A-Za-z0-9+/=_-]{28,200}\b/g;
  for (const match of String(text).matchAll(re)) {
    const candidate = match[0];
    if (entropy(candidate) >= 4.1 && /[A-Za-z]/.test(candidate) && /[0-9]/.test(candidate)) {
      results.push({ start: match.index, end: match.index + candidate.length, id: 'high-entropy-token', value: candidate });
    }
  }
  return results;
}

export function scanSecrets(value, { include_high_entropy = true } = {}) {
  const text = String(value ?? '');
  const findings = [];
  for (const pattern of SECRET_PATTERNS) {
    pattern.re.lastIndex = 0;
    for (const match of text.matchAll(pattern.re)) {
      findings.push({ id: pattern.id, start: match.index, end: match.index + match[0].length, fingerprint: fingerprint(match[0]), length: match[0].length });
    }
  }
  if (include_high_entropy) {
    for (const match of highEntropyCandidates(text)) findings.push({ id: match.id, start: match.start, end: match.end, fingerprint: fingerprint(match.value), length: match.value.length });
  }
  findings.sort((a, b) => a.start - b.start || b.end - a.end);
  const deduped = [];
  for (const finding of findings) {
    if (deduped.some(existing => finding.start >= existing.start && finding.end <= existing.end)) continue;
    deduped.push(finding);
  }
  return Object.freeze(deduped.map(Object.freeze));
}

export function redactSecrets(value) {
  if (typeof value === 'string') {
    const findings = scanSecrets(value);
    if (!findings.length) return value;
    let output = '';
    let cursor = 0;
    for (const finding of findings) {
      output += value.slice(cursor, finding.start);
      output += `[REDACTED:${finding.id}:${finding.fingerprint}]`;
      cursor = finding.end;
    }
    return output + value.slice(cursor);
  }
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, SECRET_KEY_RE.test(key) && typeof child === 'string' ? `[REDACTED:key:${fingerprint(child)}]` : redactSecrets(child)]));
}

export function classifyOrigin(value = {}) {
  const kind = clean(typeof value === 'string' ? value : value.kind, 100).toLowerCase();
  const contract = ORIGINS[kind];
  if (!contract) throw new Error(`Unknown input origin: ${kind || '(empty)'}.`);
  return Object.freeze({
    kind,
    trust: contract.trust,
    trust_level: TRUST_LEVELS[contract.trust],
    may_supply_instructions: contract.instructions,
    authenticated_actor: clean(value.authenticated_actor, 300) || null,
    source_revision: clean(value.source_revision, 200) || null,
    provenance: clean(value.provenance, 1000) || null
  });
}

export function inspectInstruction(value, originInput) {
  const origin = classifyOrigin(originInput);
  const text = clean(value, 200000);
  const matches = PROMPT_INJECTION_PATTERNS.filter(pattern => pattern.test(text)).map(pattern => pattern.source);
  const canControl = origin.may_supply_instructions && origin.trust_level >= TRUST_LEVELS.human;
  return Object.freeze({
    origin,
    instruction_authority: canControl,
    injection_signals: Object.freeze(matches),
    content_role: canControl ? 'authorized-instruction' : 'untrusted-data',
    protected_goal_mutation_allowed: canControl,
    secret_findings: scanSecrets(text)
  });
}

function normalizeScope(scope = {}) {
  const paths = sortedUnique((scope.paths || []).map(value => normalizeRelativePath(value, { allow_glob: true })));
  const hosts = sortedUnique((scope.hosts || []).map(value => clean(value, 300).toLowerCase()).filter(Boolean));
  const repositories = sortedUnique((scope.repositories || []).map(value => clean(value, 300)).filter(Boolean));
  const commands = sortedUnique((scope.commands || []).map(value => clean(value, 300)).filter(Boolean));
  return Object.freeze({ paths: Object.freeze(paths), hosts: Object.freeze(hosts), repositories: Object.freeze(repositories), commands: Object.freeze(commands) });
}

export function normalizeCapabilityGrant(input = {}, { clock = nowISO } = {}) {
  const capability = clean(input.capability, 200).toLowerCase();
  if (!/^[a-z][a-z0-9.-]+$/.test(capability)) throw new Error('Capability grant has an invalid capability.');
  const issuedBy = clean(input.issued_by, 300);
  const nonce = clean(input.nonce, 300);
  const expiresAt = clean(input.expires_at, 100);
  if (!issuedBy || !nonce || !expiresAt || input.human_approved !== true) throw new Error('Capability grant requires issuer, nonce, expiry, and human approval.');
  const now = Date.parse(clock());
  const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(expiry) || expiry <= now) throw new Error('Capability grant is expired or invalid.');
  const grant = {
    schema: GRANT_SCHEMA,
    grant_id: clean(input.grant_id || `grant-${digest(`${issuedBy}:${nonce}:${capability}`).slice(0, 20)}`, 200),
    capability,
    issued_by: issuedBy,
    nonce,
    issued_at: clean(input.issued_at, 100) || clock(),
    expires_at: new Date(expiry).toISOString(),
    human_approved: true,
    max_uses: Math.max(1, Math.min(100000, Number(input.max_uses || 1))),
    scope: normalizeScope(input.scope),
    reason: clean(input.reason, 2000) || null,
    revocable: input.revocable !== false
  };
  return Object.freeze({ ...grant, grant_digest: digest(grant) });
}

export function normalizeRelativePath(value, { allow_glob = false } = {}) {
  const raw = clean(value, 2000).replace(/\\/g, '/').replace(/^\.\//, '');
  if (!raw || raw.startsWith('/') || /^[A-Za-z]:\//.test(raw) || raw.split('/').includes('..')) throw new Error(`Path must be repository-relative: ${JSON.stringify(value)}.`);
  const segments = raw.split('/').filter(Boolean);
  if (segments.some(segment => BLOCKED_PATH_SEGMENTS.has(segment)) || SECRET_BASENAME_RE.test(segments.at(-1) || '')) throw new Error(`Protected or secret-like path is blocked: ${raw}.`);
  if (!allow_glob && /[*?\[\]{}]/.test(raw)) throw new Error(`Path glob is not allowed here: ${raw}.`);
  return segments.join('/');
}

function pathMatches(candidate, grantPath) {
  if (grantPath === '**') return true;
  if (grantPath.endsWith('/**')) {
    const prefix = grantPath.slice(0, -3);
    return candidate === prefix || candidate.startsWith(`${prefix}/`);
  }
  return candidate === grantPath;
}

function scopeMatches(scope, context = {}) {
  if (scope.paths.length) {
    let candidate;
    try { candidate = normalizeRelativePath(context.path); } catch { return false; }
    if (!scope.paths.some(pattern => pathMatches(candidate, pattern))) return false;
  }
  if (scope.hosts.length && !scope.hosts.includes(clean(context.host, 300).toLowerCase())) return false;
  if (scope.repositories.length && !scope.repositories.includes(clean(context.repository, 300))) return false;
  if (scope.commands.length && !scope.commands.includes(clean(context.command, 300))) return false;
  return true;
}

export class SecurityAuditLog {
  constructor({ clock = nowISO, events = [] } = {}) {
    this.clock = clock;
    this.events = [];
    for (const event of events) this.append(event.type, event.payload, { at: event.at, expected_digest: event.digest, expected_previous: event.previous_digest });
  }

  append(type, payload = {}, { at = this.clock(), expected_digest = null, expected_previous = undefined } = {}) {
    const previous = this.events.at(-1)?.digest || null;
    if (expected_previous !== undefined && expected_previous !== previous) throw new Error('Security audit predecessor mismatch.');
    const body = { sequence: this.events.length + 1, at, type: clean(type, 200), payload: redactSecrets(payload), previous_digest: previous };
    const event = Object.freeze({ ...body, digest: digest(body) });
    if (expected_digest && expected_digest !== event.digest) throw new Error('Security audit digest mismatch.');
    this.events.push(event);
    return event;
  }

  verify() {
    let previous = null;
    for (let index = 0; index < this.events.length; index += 1) {
      const event = this.events[index];
      if (event.sequence !== index + 1 || event.previous_digest !== previous) throw new Error(`Security audit chain mismatch at ${index + 1}.`);
      const body = { sequence: event.sequence, at: event.at, type: event.type, payload: event.payload, previous_digest: event.previous_digest };
      if (digest(body) !== event.digest) throw new Error(`Security audit digest mismatch at ${index + 1}.`);
      previous = event.digest;
    }
    return previous;
  }

  receipt() {
    const body = { schema: AUDIT_SCHEMA, event_count: this.events.length, terminal_digest: this.verify(), events: this.events };
    return Object.freeze({ ...body, receipt_digest: digest(body) });
  }
}

function isHumanOnly(capability) {
  return HUMAN_ONLY.has(capability) || capability.startsWith('deploy.') || capability.startsWith('production.') || capability.startsWith('training.');
}

function normalizeDecisionInput(input = {}) {
  const capability = clean(input.capability, 200).toLowerCase();
  if (!capability) throw new Error('Security decision requires a capability.');
  return {
    capability,
    origin: classifyOrigin(input.origin || 'model_output'),
    context: redactSecrets(input.context || {}),
    evidence: redactSecrets(input.evidence || []),
    protected_goal_change: input.protected_goal_change === true,
    human_gate: input.human_gate === true
  };
}

export class MakerSecurityPolicy {
  constructor({ clock = nowISO, resolver = async () => [], grants = [], audit = null } = {}) {
    this.clock = clock;
    this.resolver = resolver;
    this.audit = audit || new SecurityAuditLog({ clock });
    this.grants = new Map();
    this.uses = new Map();
    this.revoked = new Set();
    for (const grant of grants) this.addGrant(grant);
  }

  addGrant(input) {
    const grant = normalizeCapabilityGrant(input, { clock: this.clock });
    if (this.grants.has(grant.grant_id)) throw new Error(`Duplicate capability grant: ${grant.grant_id}.`);
    this.grants.set(grant.grant_id, grant);
    this.uses.set(grant.grant_id, 0);
    this.audit.append('grant.added', { grant });
    return grant;
  }

  revokeGrant(grantId, reason = 'operator revocation') {
    const id = clean(grantId, 200);
    if (!this.grants.has(id)) throw new Error(`Unknown capability grant: ${id}.`);
    this.revoked.add(id);
    this.audit.append('grant.revoked', { grant_id: id, reason: clean(reason, 1000) });
  }

  #eligibleGrant(capability, context) {
    const now = Date.parse(this.clock());
    for (const grant of this.grants.values()) {
      if (grant.capability !== capability || this.revoked.has(grant.grant_id)) continue;
      if (Date.parse(grant.expires_at) <= now) continue;
      if ((this.uses.get(grant.grant_id) || 0) >= grant.max_uses) continue;
      if (!scopeMatches(grant.scope, context)) continue;
      return grant;
    }
    return null;
  }

  decide(input = {}) {
    const normalized = normalizeDecisionInput(input);
    const ruleIds = [];
    let allowed = false;
    let reason = 'deny by default';
    let grant = null;
    if (normalized.protected_goal_change && !normalized.origin.may_supply_instructions) {
      ruleIds.push('SEC-INSTRUCTION-001');
      reason = 'untrusted input cannot mutate protected goals or authority';
    } else if (isHumanOnly(normalized.capability) && !(normalized.human_gate && normalized.origin.trust_level >= TRUST_LEVELS.human)) {
      ruleIds.push('SEC-HUMAN-001');
      reason = 'capability requires an explicit human gate';
    } else {
      grant = this.#eligibleGrant(normalized.capability, normalized.context);
      if (grant) {
        allowed = true;
        reason = `admitted by scoped grant ${grant.grant_id}`;
        ruleIds.push('SEC-GRANT-001');
        this.uses.set(grant.grant_id, (this.uses.get(grant.grant_id) || 0) + 1);
      } else if (normalized.capability.startsWith('read.') && normalized.origin.trust_level >= TRUST_LEVELS.authenticated) {
        allowed = true;
        reason = 'authenticated bounded read capability';
        ruleIds.push('SEC-READ-001');
      } else {
        ruleIds.push('SEC-DEFAULT-001');
      }
    }
    const body = {
      schema: DECISION_SCHEMA,
      decision_id: `decision-${crypto.randomUUID()}`,
      capability: normalized.capability,
      allowed,
      reason,
      rule_ids: ruleIds,
      origin: normalized.origin,
      context: normalized.context,
      evidence: normalized.evidence,
      grant_id: grant?.grant_id || null,
      decided_at: this.clock()
    };
    const decision = Object.freeze({ ...body, decision_digest: digest(body) });
    this.audit.append('decision', decision);
    return decision;
  }

  escalation(input = {}) {
    const body = {
      schema: ESCALATION_SCHEMA,
      escalation_id: `escalation-${crypto.randomUUID()}`,
      requested_capability: clean(input.capability, 200),
      target: redactSecrets(input.target || {}),
      reason: clean(redactSecrets(input.reason), 3000),
      requested_scope: normalizeScope(input.scope),
      requested_duration_seconds: Math.max(1, Math.min(86400, Number(input.duration_seconds || 900))),
      required_human_action: clean(input.required_human_action || 'approve or deny a scoped temporary grant', 1000),
      current_denial: redactSecrets(input.current_denial || null),
      created_at: this.clock()
    };
    const packet = Object.freeze({ ...body, escalation_digest: digest(body) });
    this.audit.append('escalation.created', packet);
    return packet;
  }

  snapshot() {
    const body = {
      schema: SCHEMA,
      grants: [...this.grants.values()].map(grant => ({ ...grant, uses: this.uses.get(grant.grant_id) || 0, revoked: this.revoked.has(grant.grant_id) })),
      audit_terminal_digest: this.audit.verify(),
      captured_at: this.clock()
    };
    return Object.freeze({ ...body, snapshot_digest: digest(body) });
  }
}

export function buildSafeEnvironment(input = {}, { allowed_names = SAFE_ENV_NAMES, secret_references = {} } = {}) {
  const env = {};
  const receipt = [];
  for (const [name, value] of Object.entries(input)) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) throw new Error(`Invalid environment variable name: ${name}.`);
    if (!allowed_names.has(name) && !Object.hasOwn(secret_references, name)) throw new Error(`Environment variable is not allowlisted: ${name}.`);
    if (Object.hasOwn(secret_references, name)) {
      const reference = clean(secret_references[name], 500);
      if (!reference) throw new Error(`Secret reference is empty: ${name}.`);
      env[name] = String(value);
      receipt.push({ name, source: 'secret-reference', reference, value_fingerprint: fingerprint(value) });
    } else {
      const text = clean(value, 8000);
      if (scanSecrets(text).length) throw new Error(`Secret-like value cannot enter ordinary environment variable ${name}.`);
      env[name] = text;
      receipt.push({ name, source: 'allowlist', value_digest: digest(text) });
    }
  }
  return Object.freeze({ env, receipt: Object.freeze(receipt) });
}

export function sanitizeProcessResult(result = {}) {
  return Object.freeze({
    code: Number(result.code ?? result.exit_code ?? 0),
    signal: clean(result.signal, 100) || null,
    stdout: clean(redactSecrets(result.stdout || ''), 200000),
    stderr: clean(redactSecrets(result.stderr || ''), 200000),
    timed_out: result.timed_out === true,
    killed: result.killed === true
  });
}

export function evaluateCommand(input = {}, { allowlist = [] } = {}) {
  const program = clean(input.program, 300);
  const args = Array.isArray(input.args) ? input.args.map(value => clean(value, 4000)) : [];
  const origin = classifyOrigin(input.origin || 'model_output');
  const errors = [];
  if (!program || program.includes('/') || program.includes('\\')) errors.push('program must be a PATH executable name');
  if (args.some(arg => /[\u0000\r\n]/.test(arg))) errors.push('arguments cannot contain control newlines');
  if (input.shell === true || input.command_string) errors.push('shell strings are not admitted');
  if (input.lifecycle_script === true || ['npm', 'pnpm', 'yarn'].includes(program) && args.some(arg => ['install', 'ci', 'add'].includes(arg)) && input.ignore_scripts !== true) errors.push('dependency lifecycle scripts require an explicit sandbox grant');
  const rule = allowlist.find(item => item.program === program && (item.prefix === true ? (item.args || []).every((value, index) => args[index] === value) : stableJSONStringify(item.args || []) === stableJSONStringify(args)));
  if (!rule) errors.push('command is not allowlisted');
  const limits = {
    timeout_ms: Math.max(100, Math.min(60 * 60 * 1000, Number(input.timeout_ms || rule?.timeout_ms || 120000))),
    max_output_bytes: Math.max(1024, Math.min(32 * 1024 * 1024, Number(input.max_output_bytes || rule?.max_output_bytes || 1024 * 1024))),
    max_processes: Math.max(1, Math.min(64, Number(input.max_processes || rule?.max_processes || 8))),
    network: input.network === true && rule?.network === true,
    container: input.container === true || rule?.container === true,
    read_only_root: input.read_only_root !== false,
    devices: []
  };
  if (origin.trust_level < TRUST_LEVELS.human && input.host_mounts?.length) errors.push('untrusted commands cannot request host mounts');
  if (input.devices?.length) errors.push('device access is denied');
  return Object.freeze({ allowed: errors.length === 0, program, args: Object.freeze(args), origin, limits: Object.freeze(limits), errors: Object.freeze(errors) });
}

export function inspectFilesystemEntry(entry = {}) {
  const relative = normalizeRelativePath(entry.path);
  const type = clean(entry.type || 'file', 40).toLowerCase();
  const errors = [];
  if (!['file', 'directory'].includes(type)) errors.push(`special filesystem object is denied: ${type}`);
  if (entry.symlink === true || entry.link_target) errors.push('symlink traversal is denied');
  if (Number(entry.nlink || 1) > 1 && type === 'file') errors.push('hard-linked file is denied');
  if (entry.device === true || entry.fifo === true || entry.socket === true) errors.push('device, FIFO, and socket nodes are denied');
  const size = Math.max(0, Number(entry.size || 0));
  if (size > Number(entry.max_bytes || 2 * 1024 * 1024)) errors.push('file exceeds bounded text size');
  return Object.freeze({ allowed: errors.length === 0, path: relative, type, size, archive: ARCHIVE_EXTENSIONS.has(path.extname(relative).toLowerCase()), errors: Object.freeze(errors) });
}

export function inspectArchive(entries = [], { max_entries = 10000, max_uncompressed_bytes = 512 * 1024 * 1024, max_ratio = 100 } = {}) {
  const errors = [];
  let totalCompressed = 0;
  let totalUncompressed = 0;
  if (entries.length > max_entries) errors.push('archive entry count exceeds limit');
  for (const entry of entries.slice(0, max_entries + 1)) {
    const name = clean(entry.path || entry.name, 4000).replace(/\\/g, '/');
    if (!name || name.startsWith('/') || /^[A-Za-z]:\//.test(name) || name.split('/').includes('..')) errors.push(`archive traversal path denied: ${name}`);
    if (entry.type && !['file', 'directory'].includes(entry.type)) errors.push(`archive special entry denied: ${name}`);
    if (entry.symlink || entry.hardlink) errors.push(`archive link entry denied: ${name}`);
    totalCompressed += Math.max(0, Number(entry.compressed_bytes || 0));
    totalUncompressed += Math.max(0, Number(entry.uncompressed_bytes || entry.size || 0));
  }
  if (totalUncompressed > max_uncompressed_bytes) errors.push('archive uncompressed size exceeds limit');
  if (totalCompressed > 0 && totalUncompressed / totalCompressed > max_ratio) errors.push('archive compression ratio exceeds limit');
  return Object.freeze({ allowed: errors.length === 0, entry_count: entries.length, compressed_bytes: totalCompressed, uncompressed_bytes: totalUncompressed, errors: Object.freeze(sortedUnique(errors)) });
}

function ipv4Blocked(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19));
}

function ipv6Blocked(address) {
  const normalized = address.toLowerCase().split('%')[0];
  return normalized === '::' || normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb') || normalized.startsWith('::ffff:127.') || normalized.startsWith('::ffff:10.') || normalized.startsWith('::ffff:192.168.');
}

export function isBlockedAddress(address) {
  const type = net.isIP(clean(address, 200));
  if (type === 4) return ipv4Blocked(address);
  if (type === 6) return ipv6Blocked(address);
  return true;
}

export async function evaluateNetworkRequest(input = {}, { resolver = async host => [{ address: host }] } = {}) {
  const errors = [];
  let url;
  try { url = new URL(clean(input.url, 4000)); } catch { return Object.freeze({ allowed: false, errors: Object.freeze(['invalid URL']) }); }
  if (url.protocol !== 'https:' && !(input.allow_http_loopback === true && ['localhost', '127.0.0.1', '::1'].includes(url.hostname))) errors.push('HTTPS is required');
  if (url.username || url.password) errors.push('URL credentials are denied');
  const hostAllowlist = (input.allowed_hosts || []).map(value => clean(value, 300).toLowerCase());
  if (hostAllowlist.length && !hostAllowlist.includes(url.hostname.toLowerCase())) errors.push('host is not allowlisted');
  const addresses = net.isIP(url.hostname) ? [{ address: url.hostname }] : await resolver(url.hostname);
  if (!addresses.length) errors.push('DNS returned no addresses');
  if (addresses.some(value => isBlockedAddress(value.address || value))) errors.push('host resolves to a private or reserved address');
  if (input.redirect_from) {
    const prior = new URL(input.redirect_from);
    if (prior.protocol === 'https:' && url.protocol !== 'https:') errors.push('HTTPS downgrade redirect denied');
    const allowedRedirectHosts = (input.allowed_redirect_hosts || hostAllowlist).map(value => clean(value, 300).toLowerCase());
    if (allowedRedirectHosts.length && !allowedRedirectHosts.includes(url.hostname.toLowerCase())) errors.push('redirect host is not admitted');
  }
  const mime = clean(input.mime, 200).toLowerCase();
  if (mime && !ALLOWED_MIME_PREFIXES.some(prefix => mime === prefix || mime.startsWith(prefix))) errors.push('response MIME is not admitted');
  const bytes = Math.max(0, Number(input.content_length || 0));
  const maxBytes = Math.max(1, Math.min(1024 * 1024 * 1024, Number(input.max_bytes || 20 * 1024 * 1024)));
  if (bytes > maxBytes) errors.push('response exceeds byte limit');
  return Object.freeze({ allowed: errors.length === 0, url: url.toString(), host: url.hostname, addresses: Object.freeze(addresses.map(value => clean(value.address || value, 200))), max_bytes: maxBytes, errors: Object.freeze(sortedUnique(errors)) });
}

export function evaluateBrowserAction(input = {}) {
  const action = clean(input.action, 100).toLowerCase();
  const errors = [];
  if (!['navigate', 'download', 'upload', 'click', 'type', 'screenshot'].includes(action)) errors.push('unknown browser action');
  if (action === 'upload') {
    if (input.human_approved !== true) errors.push('browser upload requires explicit human approval');
    try { normalizeRelativePath(input.path); } catch (error) { errors.push(error.message); }
    if (input.contains_secret === true) errors.push('secret-bearing upload is denied');
  }
  if (action === 'download' && input.quarantine !== true) errors.push('downloads must enter quarantine');
  if (action === 'type' && scanSecrets(input.text || '').length) errors.push('typing secret-like material is denied');
  return Object.freeze({ allowed: errors.length === 0, action, errors: Object.freeze(errors) });
}

export function evaluateDependency(input = {}) {
  const errors = [];
  const name = clean(input.name, 300);
  const version = clean(input.version, 200);
  if (!name || !version) errors.push('dependency name and exact version are required');
  if (/[*xX]|\blatest\b|^[~^><=]/.test(version)) errors.push('dependency version must be exact');
  if (input.lockfile_present !== true) errors.push('lockfile evidence is required');
  if (!clean(input.integrity, 500) && !clean(input.checksum, 500)) errors.push('integrity or checksum evidence is required');
  if (input.registry_host && !(input.allowed_registry_hosts || []).includes(input.registry_host)) errors.push('registry host is not allowlisted');
  if (input.lifecycle_scripts === true && input.sandboxed !== true) errors.push('dependency lifecycle scripts require sandboxing');
  if (input.name_confusion === true || input.typosquat_score > 0.8) errors.push('dependency confusion or typosquat risk');
  if (input.license && (input.denied_licenses || []).includes(input.license)) errors.push('dependency license is denied');
  return Object.freeze({ allowed: errors.length === 0, name, version, errors: Object.freeze(errors) });
}
