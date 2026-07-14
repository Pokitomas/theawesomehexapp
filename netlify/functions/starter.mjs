import { createHash } from 'node:crypto';
import { getStore } from '@netlify/blobs';
import { starterPack } from '../../studio/manual/product/starter-pack.js';

const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const reply = (status, body = {}) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
const clean = value => String(value || '').replace(/\u0000/g, '').trim();
const profileId = deviceId => createHash('sha256').update(deviceId).digest('hex').slice(0, 24);

export default async request => {
  if (request.method === 'OPTIONS') return reply(204, {});
  if (request.method !== 'POST') return reply(405, { error: 'Method not allowed.' });
  const body = await request.json().catch(() => ({}));
  const deviceId = clean(body.deviceId).slice(0, 160);
  if (!deviceId) return reply(400, { error: 'Device required.' });
  const profiles = getStore('sideways-profiles');
  const profile = await profiles.get(profileId(deviceId), { type: 'json' }) || body.profile || {};
  return reply(200, { version: 1, items: starterPack(profile) });
};
