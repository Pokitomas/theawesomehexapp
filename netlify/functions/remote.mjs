import { getStore } from '@netlify/blobs';
import { sanitizePublicRemoteResponse } from './remote-public-response.mjs';
import { createRemoteHandler } from './remote-service.mjs';

const handler = createRemoteHandler({ store: getStore('sideways-remote') });
export default async request => sanitizePublicRemoteResponse(request, await handler(request));
