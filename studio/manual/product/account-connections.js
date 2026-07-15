const PROVIDERS = Object.freeze([
  { id: 'mastodon', name: 'Mastodon', scopes: ['read:accounts', 'read:statuses'], authorizationPath: '/api/connections/mastodon/authorize' },
  { id: 'reddit', name: 'Reddit', scopes: ['identity', 'history', 'mysubreddits', 'read'], authorizationPath: '/api/connections/reddit/authorize' },
  { id: 'youtube', name: 'YouTube', scopes: ['https://www.googleapis.com/auth/youtube.readonly'], authorizationPath: '/api/connections/youtube/authorize' },
  { id: 'spotify', name: 'Spotify', scopes: ['user-read-private', 'user-library-read', 'user-read-recently-played'], authorizationPath: '/api/connections/spotify/authorize' },
  { id: 'instagram', name: 'Instagram', scopes: ['instagram_graph_user_profile', 'instagram_graph_user_media'], authorizationPath: '/api/connections/instagram/authorize' }
]);

const SENSITIVE_KEY = /(?:access|refresh|id)?token|secret|password|cookie|authorizationcode|codeverifier|credential/i;

function clean(value = '') {
  return value == null ? '' : String(value).replace(/[\u0000-\u001f\u007f]/g, '').trim();
}

function base64url(bytes) {
  const binary = String.fromCharCode(...bytes);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function secureBytes(length, cryptoObject = globalThis.crypto) {
  if (!cryptoObject?.getRandomValues) throw new Error('Secure browser cryptography is required.');
  return cryptoObject.getRandomValues(new Uint8Array(length));
}

export function providerCatalog(configuration = {}) {
  return PROVIDERS.map(provider => Object.freeze({
    ...provider,
    configured: Boolean(configuration[provider.id]?.clientId && configuration[provider.id]?.redirectUri && configuration[provider.id]?.authorizationEndpoint),
    redirectUri: clean(configuration[provider.id]?.redirectUri || '')
  }));
}

export function providerById(id, configuration = {}) {
  const provider = providerCatalog(configuration).find(item => item.id === id);
  if (!provider) throw new Error('Unknown account provider.');
  return provider;
}

export async function createPKCE(cryptoObject = globalThis.crypto) {
  if (!cryptoObject?.subtle) throw new Error('Secure browser cryptography is required.');
  const verifier = base64url(secureBytes(48, cryptoObject));
  const digest = await cryptoObject.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return Object.freeze({ verifier, challenge: base64url(new Uint8Array(digest)), method: 'S256' });
}

export function validateRedirectURI(redirectUri, allowedRedirects = []) {
  const redirect = new URL(redirectUri);
  const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(redirect.hostname);
  if (redirect.protocol !== 'https:' && !(local && redirect.protocol === 'http:')) throw new Error('OAuth callbacks require HTTPS except loopback development callbacks.');
  if (redirect.username || redirect.password || redirect.hash) throw new Error('OAuth callback URL is invalid.');
  const normalized = `${redirect.origin}${redirect.pathname}`;
  if (allowedRedirects.length && !allowedRedirects.some(value => {
    const allowed = new URL(value);
    return `${allowed.origin}${allowed.pathname}` === normalized;
  })) throw new Error('OAuth callback URL is not allowlisted.');
  return redirect;
}

export function createConnectionState({ providerId, redirectUri, allowedRedirects = [], cryptoObject = globalThis.crypto, nonceBytes, stateBytes, now = () => new Date().toISOString() }) {
  const provider = clean(providerId);
  if (!PROVIDERS.some(item => item.id === provider)) throw new Error('Unknown account provider.');
  const redirect = validateRedirectURI(redirectUri, allowedRedirects);
  return Object.freeze({
    schema: 'sideways-connection-state/v1',
    provider,
    state: base64url(stateBytes || secureBytes(24, cryptoObject)),
    nonce: base64url(nonceBytes || secureBytes(24, cryptoObject)),
    redirectUri: redirect.href,
    createdAt: now()
  });
}

export function buildAuthorizationURL({ provider, endpoint, clientId, redirectUri, allowedRedirects = [], scopes, state, nonce, challenge }) {
  const target = new URL(endpoint);
  if (target.protocol !== 'https:' || target.username || target.password || target.hash) throw new Error('Authorization endpoint must use clean HTTPS.');
  const callback = validateRedirectURI(redirectUri, allowedRedirects);
  const allowedScopes = new Set(provider?.scopes || []);
  const requestedScopes = [...new Set(scopes || provider?.scopes || [])];
  if (!requestedScopes.length || requestedScopes.some(scope => !allowedScopes.has(scope))) throw new Error('Requested OAuth scopes exceed the provider allowlist.');
  for (const [name, value] of Object.entries({ clientId, state, nonce, challenge })) {
    if (!clean(value)) throw new Error(`OAuth ${name} is required.`);
  }
  target.search = new URLSearchParams({
    response_type: 'code',
    client_id: clean(clientId),
    redirect_uri: callback.href,
    scope: requestedScopes.join(' '),
    state: clean(state),
    nonce: clean(nonce),
    code_challenge: clean(challenge),
    code_challenge_method: 'S256'
  }).toString();
  return target.href;
}

export function validateCallback(callbackURL, expected) {
  const url = new URL(callbackURL);
  const expectedRedirect = validateRedirectURI(expected.redirectUri, [expected.redirectUri]);
  if (`${url.origin}${url.pathname}` !== `${expectedRedirect.origin}${expectedRedirect.pathname}`) throw new Error('OAuth callback URL did not match.');
  if (url.hash) throw new Error('OAuth callback fragments are not accepted.');
  const state = clean(url.searchParams.get('state'));
  const code = clean(url.searchParams.get('code'));
  const error = clean(url.searchParams.get('error'));
  if (error) throw new Error(`Connection was not authorized: ${error}`);
  if (!state || state !== clean(expected.state)) throw new Error('OAuth state did not match.');
  if (!code) throw new Error('OAuth callback did not include a code.');
  return Object.freeze({ code, state, provider: expected.provider });
}

function redactValue(value) {
  if (Array.isArray(value)) return value.map(redactValue);
  if (!value || typeof value !== 'object') return typeof value === 'string' ? clean(value) : value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !SENSITIVE_KEY.test(key.replace(/[^a-z0-9]/gi, '')))
    .map(([key, child]) => [key, redactValue(child)]));
}

export function redactConnection(connection = {}) {
  return Object.freeze(redactValue(connection));
}

export function createDisconnectReceipt({ provider, connectionId, revoked = false, deletedServerState = false, at = new Date().toISOString() } = {}) {
  const receipt = redactConnection({
    schema: 'sideways-connection-disconnect/v1',
    provider: clean(provider),
    connectionId: clean(connectionId),
    revoked: Boolean(revoked),
    deletedServerState: Boolean(deletedServerState),
    disconnectedAt: at
  });
  if (!receipt.provider || !receipt.connectionId) throw new Error('Disconnect receipt requires provider and connection ID.');
  return Object.freeze(receipt);
}

export function reduceSyncState(current = {}, event = {}) {
  const seen = new Set(Array.isArray(current.seenIds) ? current.seenIds.map(clean).filter(Boolean) : []);
  const base = {
    schema: 'sideways-connected-sync/v1',
    provider: clean(current.provider || event.provider),
    status: current.status || 'idle',
    cursor: current.cursor || null,
    imported: Math.max(0, Number(current.imported || 0)),
    seenIds: [...seen].slice(-1000),
    lastSyncAt: current.lastSyncAt || null,
    error: null
  };
  if (event.type === 'start') return Object.freeze({ ...base, status: 'syncing', error: null });
  if (event.type === 'page') {
    const ids = [...new Set((Array.isArray(event.ids) ? event.ids : []).map(clean).filter(Boolean))];
    const unique = ids.filter(id => !seen.has(id));
    unique.forEach(id => seen.add(id));
    const added = ids.length ? unique.length : Math.max(0, Number(event.added || 0));
    return Object.freeze({ ...base, status: 'syncing', cursor: event.cursor ?? base.cursor, imported: base.imported + added, seenIds: [...seen].slice(-1000) });
  }
  if (event.type === 'complete') return Object.freeze({ ...base, status: 'connected', cursor: event.cursor ?? base.cursor, lastSyncAt: event.at || new Date().toISOString(), error: null });
  if (event.type === 'cancel') return Object.freeze({ ...base, status: 'connected', error: null });
  if (event.type === 'disconnect') return Object.freeze({ ...base, status: 'disconnected', cursor: null, seenIds: [], error: null });
  if (event.type === 'error') return Object.freeze({ ...base, status: 'error', error: clean(event.message || 'Sync failed.') });
  throw new Error('Unknown connection sync event.');
}

export function connectionCapability({ staticDeployment = true, configured = false } = {}) {
  if (staticDeployment) return Object.freeze({ state: 'unavailable', reason: 'Account connections require a configured server callback. File import and public feeds remain available.' });
  if (!configured) return Object.freeze({ state: 'unavailable', reason: 'This provider is not configured for this deployment.' });
  return Object.freeze({ state: 'available', reason: 'Authorization opens on the provider and can be revoked.' });
}

export { PROVIDERS };
