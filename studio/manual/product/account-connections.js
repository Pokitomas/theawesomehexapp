const PROVIDERS = Object.freeze([
  { id: 'mastodon', name: 'Mastodon', scopes: ['read:accounts', 'read:statuses'], authorizationPath: '/api/connections/mastodon/authorize' },
  { id: 'reddit', name: 'Reddit', scopes: ['identity', 'history', 'mysubreddits', 'read'], authorizationPath: '/api/connections/reddit/authorize' },
  { id: 'youtube', name: 'YouTube', scopes: ['https://www.googleapis.com/auth/youtube.readonly'], authorizationPath: '/api/connections/youtube/authorize' },
  { id: 'spotify', name: 'Spotify', scopes: ['user-read-private', 'user-library-read', 'user-read-recently-played'], authorizationPath: '/api/connections/spotify/authorize' },
  { id: 'instagram', name: 'Instagram', scopes: ['instagram_graph_user_profile', 'instagram_graph_user_media'], authorizationPath: '/api/connections/instagram/authorize' }
]);

function clean(value = '') { return value == null ? '' : String(value).replace(/[\u0000-\u001f\u007f]/g, '').trim(); }
function base64url(bytes) { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }

export function providerCatalog(configuration = {}) {
  return PROVIDERS.map(provider => Object.freeze({
    ...provider,
    configured: Boolean(configuration[provider.id]?.clientId && configuration[provider.id]?.redirectUri),
    redirectUri: clean(configuration[provider.id]?.redirectUri || ''),
    clientId: clean(configuration[provider.id]?.clientId || '')
  }));
}

export function providerById(id, configuration = {}) {
  const provider = providerCatalog(configuration).find(item => item.id === id);
  if (!provider) throw new Error('Unknown account provider.');
  return provider;
}

export async function createPKCE(cryptoObject = globalThis.crypto) {
  if (!cryptoObject?.getRandomValues || !cryptoObject?.subtle) throw new Error('Secure browser cryptography is required.');
  const verifierBytes = new Uint8Array(48);
  cryptoObject.getRandomValues(verifierBytes);
  const verifier = base64url(verifierBytes);
  const digest = await cryptoObject.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return Object.freeze({ verifier, challenge: base64url(new Uint8Array(digest)), method: 'S256' });
}

export function createConnectionState({ providerId, redirectUri, nonceBytes, stateBytes }) {
  const provider = clean(providerId);
  if (!PROVIDERS.some(item => item.id === provider)) throw new Error('Unknown account provider.');
  const redirect = new URL(redirectUri);
  if (redirect.protocol !== 'https:' && redirect.hostname !== 'localhost') throw new Error('OAuth callbacks require HTTPS.');
  if (redirect.username || redirect.password || redirect.hash) throw new Error('OAuth callback URL is invalid.');
  return Object.freeze({
    schema: 'sideways-connection-state/v1',
    provider,
    state: base64url(stateBytes || crypto.getRandomValues(new Uint8Array(24))),
    nonce: base64url(nonceBytes || crypto.getRandomValues(new Uint8Array(24))),
    redirectUri: redirect.href,
    createdAt: new Date().toISOString()
  });
}

export function buildAuthorizationURL({ provider, endpoint, clientId, redirectUri, scopes, state, nonce, challenge }) {
  const target = new URL(endpoint);
  if (target.protocol !== 'https:') throw new Error('Authorization endpoint must use HTTPS.');
  target.search = new URLSearchParams({
    response_type: 'code', client_id: clean(clientId), redirect_uri: new URL(redirectUri).href,
    scope: (scopes || provider?.scopes || []).join(' '), state: clean(state), nonce: clean(nonce),
    code_challenge: clean(challenge), code_challenge_method: 'S256'
  }).toString();
  return target.href;
}

export function validateCallback(callbackURL, expected) {
  const url = new URL(callbackURL);
  const state = clean(url.searchParams.get('state'));
  const code = clean(url.searchParams.get('code'));
  const error = clean(url.searchParams.get('error'));
  if (error) throw new Error(`Connection was not authorized: ${error}`);
  if (!state || state !== clean(expected.state)) throw new Error('OAuth state did not match.');
  if (!code) throw new Error('OAuth callback did not include a code.');
  if (url.origin + url.pathname !== new URL(expected.redirectUri).origin + new URL(expected.redirectUri).pathname) throw new Error('OAuth callback URL did not match.');
  return Object.freeze({ code, state, provider: expected.provider });
}

export function redactConnection(connection = {}) {
  const forbidden = new Set(['accessToken', 'refreshToken', 'token', 'clientSecret', 'codeVerifier', 'authorizationCode', 'cookie']);
  return Object.freeze(Object.fromEntries(Object.entries(connection).filter(([key]) => !forbidden.has(key)).map(([key, value]) => [key, typeof value === 'string' ? clean(value) : value])));
}

export function reduceSyncState(current = {}, event = {}) {
  const base = { schema: 'sideways-connected-sync/v1', provider: clean(current.provider || event.provider), status: current.status || 'idle', cursor: current.cursor || null, imported: Number(current.imported || 0), lastSyncAt: current.lastSyncAt || null, error: null };
  if (event.type === 'start') return Object.freeze({ ...base, status: 'syncing', error: null });
  if (event.type === 'page') return Object.freeze({ ...base, status: 'syncing', cursor: event.cursor ?? base.cursor, imported: base.imported + Math.max(0, Number(event.added || 0)) });
  if (event.type === 'complete') return Object.freeze({ ...base, status: 'connected', cursor: event.cursor ?? base.cursor, lastSyncAt: event.at || new Date().toISOString(), error: null });
  if (event.type === 'cancel') return Object.freeze({ ...base, status: 'connected', error: null });
  if (event.type === 'disconnect') return Object.freeze({ ...base, status: 'disconnected', cursor: null, error: null });
  if (event.type === 'error') return Object.freeze({ ...base, status: 'error', error: clean(event.message || 'Sync failed.') });
  throw new Error('Unknown connection sync event.');
}

export function connectionCapability({ staticDeployment = true, configured = false } = {}) {
  if (staticDeployment) return Object.freeze({ state: 'unavailable', reason: 'Account connections require a configured server callback. File import and public feeds remain available.' });
  if (!configured) return Object.freeze({ state: 'unavailable', reason: 'This provider is not configured for this deployment.' });
  return Object.freeze({ state: 'available', reason: 'Authorization opens on the provider and can be revoked.' });
}

export { PROVIDERS };
