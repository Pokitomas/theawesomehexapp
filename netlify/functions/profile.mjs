import { createHash } from 'node:crypto';
import { getStore } from '@netlify/blobs';

const COLORS = new Set(['#335cff', '#2f7d64', '#b24d6b', '#8a5b24', '#6554c0', '#24262b']);
const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const reply = (status, body = {}) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
const clean = value => String(value || '').replace(/\u0000/g, '').trim();
const handleOf = value => clean(value).replace(/^@/, '').toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 30);
const profileId = deviceId => createHash('sha256').update(deviceId).digest('hex').slice(0, 24);

export default async request => {
  if (request.method === 'OPTIONS') return reply(204, {});
  const url = new URL(request.url);
  const handles = getStore('sideways-handles');
  const profiles = getStore('sideways-profiles');

  if (request.method === 'GET') {
    const handle = handleOf(url.searchParams.get('handle'));
    const deviceId = clean(url.searchParams.get('deviceId'));
    const id = deviceId ? profileId(deviceId) : '';
    if (!handle) return reply(400, { error: 'Handle required.' });
    const owner = await handles.get(handle, { type: 'json' });
    return reply(200, { available: !owner || owner.profileId === id, handle });
  }

  if (request.method !== 'POST') return reply(405, { error: 'Method not allowed.' });
  const body = await request.json().catch(() => ({}));
  const deviceId = clean(body.deviceId).slice(0, 160);
  const name = clean(body.name).slice(0, 48);
  const handle = handleOf(body.handle);
  const bio = clean(body.bio).slice(0, 180);
  const accent = COLORS.has(body.accent) ? body.accent : '#335cff';
  if (!deviceId || !name || handle.length < 2) return reply(400, { error: 'Name, handle, and device are required.' });

  const id = profileId(deviceId);
  const owner = await handles.get(handle, { type: 'json' });
  if (owner && owner.profileId !== id) return reply(409, { error: 'That handle is taken.' });
  const previous = await profiles.get(id, { type: 'json' });
  if (previous?.handle && previous.handle !== handle) {
    const previousOwner = await handles.get(previous.handle, { type: 'json' });
    if (previousOwner?.profileId === id) await handles.delete(previous.handle);
  }

  const profile = { id, name, handle, bio, accent, updatedAt: new Date().toISOString() };
  await profiles.setJSON(id, profile);
  await handles.setJSON(handle, { profileId: id, updatedAt: profile.updatedAt });
  return reply(200, { profile });
};
