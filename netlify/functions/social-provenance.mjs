const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const clean = value => String(value ?? '').trim();

export function cookieMutationProvenanceError(request) {
  const method = clean(request?.method).toUpperCase() || 'GET';
  if (SAFE_METHODS.has(method)) return '';

  const targetOrigin = new URL(request.url).origin;
  const origin = clean(request.headers.get('origin'));
  const fetchSite = clean(request.headers.get('sec-fetch-site')).toLowerCase();

  if (origin && origin !== targetOrigin) return 'Cross-origin mutation rejected.';
  if (fetchSite && fetchSite !== 'same-origin') return 'Cross-site mutation rejected.';
  if (!origin && fetchSite !== 'same-origin') return 'Mutation provenance required.';
  return '';
}

export function cookieMutationProvenanceResponse(request) {
  const error = cookieMutationProvenanceError(request);
  if (!error) return null;
  return new Response(JSON.stringify({ error }), {
    status: 403,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}
