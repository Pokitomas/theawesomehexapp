import { getStore } from '@netlify/blobs';
import { createRemoteHandler } from './remote-core.mjs';

export default createRemoteHandler({ getStore });
