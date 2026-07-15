import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

export const DEFAULT_FETCH_LIMITS = Object.freeze({
  bytes: 2_000_000,
  redirects: 4,
  timeoutMs: 20_000,
  robotsBytes: 256_000
});

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const USER_AGENT = 'SidewaysDiscovery/1.0 (+https://github.com/Pokitomas/theawesomehexapp)';

function ipv4Octets(address) {
  const values = String(address).split('.').map(Number);
  return values.length === 4 && values.every(value => Number.isInteger(value) && value >= 0 && value <= 255) ? values : null;
}

function publicIPv4(address) {
  const octets = ipv4Octets(address);
  if (!octets) return false;
  const [a, b, c] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function publicIPv6(address) {
  const value = String(address).toLowerCase().split('%')[0];
  if (value === '::' || value === '::1') return false;
  if (value.startsWith('::ffff:')) return publicIPv4(value.slice(7));
  if (/^f[cd]/.test(value) || /^f[ef][89ab]/.test(value) || value.startsWith('ff')) return false;
  if (value === '2001:db8::' || value.startsWith('2001:db8:')) return false;
  return true;
}

export function isPublicAddress(address) {
  const family = net.isIP(String(address));
  if (family === 4) return publicIPv4(address);
  if (family === 6) return publicIPv6(address);
  return false;
}

export function safeSourceURL(value) {
  const parsed = new URL(String(value));
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('source protocol must be HTTP or HTTPS');
  if (parsed.username || parsed.password) throw new Error('source URL cannot contain credentials');
  for (const key of parsed.searchParams.keys()) {
    if (/(?:token|secret|api[-_]?key|access[-_]?key|credential|password)/i.test(key)) {
      throw new Error('source URL cannot contain secret-like query parameters');
    }
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new Error('source URL cannot target a private network');
  }
  if (net.isIP(host) && !isPublicAddress(host)) throw new Error('source URL cannot target a private network');
  parsed.hostname = host;
  parsed.hash = '';
  return parsed;
}

export async function resolvePublicTarget(value, { lookup = dns.lookup } = {}) {
  const url = safeSourceURL(value);
  const literalFamily = net.isIP(url.hostname);
  const answers = literalFamily
    ? [{ address: url.hostname, family: literalFamily }]
    : await lookup(url.hostname, { all: true, verbatim: true });
  if (!Array.isArray(answers) || answers.length === 0) throw new Error('source hostname did not resolve');
  const normalized = answers.map(answer => ({ address: String(answer.address), family: Number(answer.family) || net.isIP(answer.address) }));
  if (normalized.some(answer => !isPublicAddress(answer.address))) throw new Error('source hostname resolved to a non-public address');
  normalized.sort((left, right) => left.family - right.family || left.address.localeCompare(right.address));
  return Object.freeze({ url, addresses: Object.freeze(normalized), selected: Object.freeze(normalized[0]) });
}

async function requestOnce(target, { lookup, timeoutMs, byteLimit, accept }) {
  const resolved = await resolvePublicTarget(target, { lookup });
  return new Promise((resolve, reject) => {
    const transport = resolved.url.protocol === 'https:' ? https : http;
    const selected = resolved.selected;
    const request = transport.request(resolved.url, {
      method: 'GET',
      headers: { accept, 'user-agent': USER_AGENT },
      family: selected.family,
      autoSelectFamily: false,
      servername: net.isIP(resolved.url.hostname) ? undefined : resolved.url.hostname,
      timeout: timeoutMs,
      lookup(_hostname, _options, callback) {
        callback(null, selected.address, selected.family);
      }
    }, response => {
      const status = Number(response.statusCode || 0);
      const declared = Number(response.headers['content-length'] || 0);
      if (declared > byteLimit) {
        response.destroy(new Error('source exceeds byte limit'));
        return;
      }
      if (REDIRECT_STATUSES.has(status)) {
        response.resume();
        resolve({ status, headers: response.headers, body: Buffer.alloc(0), url: resolved.url, address: selected.address });
        return;
      }
      let bytes = 0;
      const chunks = [];
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > byteLimit) {
          response.destroy(new Error('source exceeds byte limit'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({ status, headers: response.headers, body: Buffer.concat(chunks), url: resolved.url, address: selected.address }));
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('source request timed out')));
    request.on('error', reject);
    request.end();
  });
}

export async function requestPublicResource(value, options = {}) {
  const limits = { ...DEFAULT_FETCH_LIMITS, ...options };
  const lookup = options.lookup || dns.lookup;
  let current = safeSourceURL(value);
  const hops = [];
  for (let hop = 0; hop <= limits.redirects; hop += 1) {
    const response = await requestOnce(current, {
      lookup,
      timeoutMs: limits.timeoutMs,
      byteLimit: limits.bytes,
      accept: options.accept || '*/*'
    });
    hops.push(Object.freeze({ url: current.href, status: response.status, address: response.address }));
    if (!REDIRECT_STATUSES.has(response.status)) return Object.freeze({ ...response, hops: Object.freeze(hops) });
    if (!response.headers.location) throw new Error('source redirect omitted a location');
    if (hop >= limits.redirects) throw new Error('source exceeded redirect limit');
    const next = safeSourceURL(new URL(response.headers.location, current).href);
    if (current.protocol === 'https:' && next.protocol !== 'https:') throw new Error('source redirect attempted an HTTPS downgrade');
    current = next;
  }
  throw new Error('source exceeded redirect limit');
}

function parseRobots(text) {
  const groups = [];
  let current = null;
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key === 'user-agent') {
      current = { agents: [value.toLowerCase()], rules: [] };
      groups.push(current);
    } else if ((key === 'allow' || key === 'disallow') && current) {
      current.rules.push({ allow: key === 'allow', path: value });
    }
  }
  return groups;
}

export function robotsAllows(text, pathname, userAgent = 'sidewaysdiscovery') {
  const groups = parseRobots(text).filter(group => group.agents.some(agent => agent === '*' || userAgent.toLowerCase().includes(agent)));
  let selected = null;
  for (const group of groups) {
    for (const rule of group.rules) {
      if (!rule.path || !pathname.startsWith(rule.path)) continue;
      if (!selected || rule.path.length > selected.path.length || (rule.path.length === selected.path.length && rule.allow)) selected = rule;
    }
  }
  return selected ? selected.allow : true;
}

export async function enforceRobots(provider, source, options = {}) {
  const policy = provider.robots || (provider.method?.includes('api') ? 'not-applicable' : 'respect');
  if (policy === 'not-applicable') return Object.freeze({ policy, allowed: true });
  if (policy !== 'respect') throw new Error('source robots policy must be respect or not-applicable');
  const response = await requestPublicResource(new URL('/robots.txt', source), {
    lookup: options.lookup,
    timeoutMs: Math.min(options.timeoutMs || DEFAULT_FETCH_LIMITS.timeoutMs, 8000),
    bytes: options.robotsBytes || DEFAULT_FETCH_LIMITS.robotsBytes,
    redirects: Math.min(options.redirects ?? DEFAULT_FETCH_LIMITS.redirects, 2),
    accept: 'text/plain,*/*;q=0.1'
  });
  if (response.status === 404 || response.status === 410) return Object.freeze({ policy, allowed: true, status: response.status });
  if (response.status < 200 || response.status >= 300) throw new Error(`robots.txt responded ${response.status}`);
  if (!robotsAllows(response.body.toString('utf8'), source.pathname)) throw new Error('source is disallowed by robots policy');
  return Object.freeze({ policy, allowed: true, status: response.status });
}
