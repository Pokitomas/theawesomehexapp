import { getStore } from '@netlify/blobs';
import { sanitizePublicRemoteResponse } from './remote-public-response.mjs';
import { createRemoteHandler } from './remote-service.mjs';
import { validateRemoteWeaveRequest } from './remote-weave-envelope.mjs';

const handler = createRemoteHandler({ store: getStore('sideways-remote') });

export default async request => {
  try {
    await validateRemoteWeaveRequest(request);
  } catch (error) {
    return Response.json({ error: String(error?.message || 'Invalid weave envelope.') }, { status: 400 });
  }
  return sanitizePublicRemoteResponse(request, await handler(request));
};
