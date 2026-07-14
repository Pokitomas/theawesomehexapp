import { getStore } from '@netlify/blobs';
import { createRemoteHandler } from './remote-service.mjs';

const handler = createRemoteHandler({ store: getStore('sideways-remote') });
export default request => handler(request);
