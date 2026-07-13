import {
  LEGACY_SOCIAL_DB,
  requestResult,
  transactionDone
} from './workspace-db.js';
import { normalizeProfile, readMeta, setMeta } from './workspace-profile.js';
import { buildRecord, dataURLToImage, insertRecord, listRecords, refreshCorpus } from './workspace-records.js';

const LEGACY_MIGRATION_KEY = 'legacy-social-migrated-v1';

async function legacySocialPosts() {
  if (indexedDB.databases) {
    const databases = await indexedDB.databases();
    if (!databases.some(item => item.name === LEGACY_SOCIAL_DB)) return [];
  }
  return new Promise(resolve => {
    const request = indexedDB.open(LEGACY_SOCIAL_DB);
    request.onerror = () => resolve([]);
    request.onsuccess = async () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('posts')) {
        db.close();
        resolve([]);
        return;
      }
      try {
        const transaction = db.transaction('posts', 'readonly');
        const posts = await requestResult(transaction.objectStore('posts').getAll());
        await transactionDone(transaction);
        resolve(posts || []);
      } catch {
        resolve([]);
      } finally {
        db.close();
      }
    };
  });
}

export async function migrateLegacySocial() {
  if (await readMeta(LEGACY_MIGRATION_KEY)) return { added: 0, complete: true };
  const legacy = await legacySocialPosts();
  const existing = new Set((await listRecords()).map(record => record.nativeId).filter(Boolean));
  let added = 0;
  for (const post of legacy) {
    const nativeId = `sideways:legacy:${post.id}`;
    if (existing.has(nativeId)) continue;
    const image = await dataURLToImage(post.image).catch(() => null);
    const profile = normalizeProfile(post.author || {});
    const record = await buildRecord({ text: post.text || post['remixText'] || '', image }, {
      nativeId,
      createdAt: post.createdAt,
      profile,
      author: {
        name: String(post.author?.name || profile.name).slice(0, 80),
        handle: post.author?.handle ? `@${String(post.author.handle).replace(/^@/, '').slice(0, 47)}` : '',
        url: '',
        avatar: ''
      }
    });
    await insertRecord(record, image);
    existing.add(nativeId);
    added += 1;
  }
  await setMeta(LEGACY_MIGRATION_KEY, { added, at: new Date().toISOString() });
  if (added) await refreshCorpus({ action: 'migrate', added });
  return { added, complete: true };
}
