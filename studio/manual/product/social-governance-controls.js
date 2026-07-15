import { Workspace } from './workspace.js';

const API = '/api/social';
const TIMEOUT = 9000;
const RELATIONAL_UNAVAILABLE = new Set([404, 405, 501]);
const ROLES = new Set(['member', 'moderator', 'owner']);
export const OPERATION_METHODS = Object.freeze({
  community: Object.freeze(['GET', 'POST']),
  'community-member': Object.freeze(['POST']),
  'community-role': Object.freeze(['POST']),
  'community-fork': Object.freeze(['POST']),
  'community-feed': Object.freeze(['GET']),
  thread: Object.freeze(['GET']),
  post: Object.freeze(['POST', 'PATCH']),
  report: Object.freeze(['POST']),
  moderate: Object.freeze(['POST']),
  appeal: Object.freeze(['POST']),
  'appeal-decide': Object.freeze(['POST']),
  'local-control': Object.freeze(['POST'])
});
let dialog = null;
let decorateQueued = false;
let mutationSerial = 0;

const el = (tag, className = '', text = '') => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== '') node.textContent = text;
  return node;
};

function action(label, onClick, className = 'social-secondary') {
  const button = el('button', className, label);
  button.type = 'button';
  button.addEventListener('click', onClick);
  return button;
}

function idempotencyKey(op) {
  mutationSerial += 1;
  const account = window.SidewaysSocial?.account?.();
  return `sideways-ui:${account?.id || account?.handle || 'anon'}:${op}:${Date.now().toString(36)}:${mutationSerial}`.slice(0, 160);
}

async function request(op, { method = 'GET', query = {}, body } = {}) {
  const declared = OPERATION_METHODS[op];
  if (declared && !declared.includes(method)) throw new Error(`Unsupported client method ${method} for ${op}.`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  const url = new URL(API, location.origin);
  url.searchParams.set('op', op);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && String(value) !== '') url.searchParams.set(key, String(value));
  }
  const headers = { 'content-type': 'application/json' };
  if (method !== 'GET') headers['idempotency-key'] = idempotencyKey(op);
  try {
    const response = await fetch(`${url.pathname}${url.search}`, {
      method,
      credentials: 'same-origin',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || `Request failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function explainError(error, operation = 'This action') {
  if (error?.name === 'AbortError') return `${operation} timed out.`;
  if (RELATIONAL_UNAVAILABLE.has(Number(error?.status))) return `${operation} requires the relational PostgreSQL social deployment. No shared change was simulated.`;
  return error?.message || `${operation} failed.`;
}

function socialStatus(message, tone = '') {
  const status = document.querySelector('[data-social-spine] .social-spine-status');
  if (!status) return;
  status.textContent = message;
  status.dataset.tone = tone;
  status.hidden = !message;
}

function closeDialog() {
  if (!dialog) return;
  if (dialog.open && dialog.close) dialog.close();
  dialog.remove();
  dialog = null;
}

function field(label, { type = 'text', value = '', placeholder = '', rows = 0 } = {}) {
  const wrap = el('label', 'social-field');
  wrap.append(el('span', 'social-field-label', label));
  const input = type === 'textarea' ? el('textarea', 'social-input') : el('input', 'social-input');
  if (type !== 'textarea') input.type = type;
  if (rows) input.rows = rows;
  input.value = value;
  input.placeholder = placeholder;
  input.autocomplete = 'off';
  wrap.append(input);
  return { wrap, input };
}

function selectField(label, values, selected = '') {
  const wrap = el('label', 'social-field');
  wrap.append(el('span', 'social-field-label', label));
  const input = el('select', 'social-input');
  for (const value of values) {
    const option = el('option', '', value);
    option.value = value;
    option.selected = value === selected;
    input.append(option);
  }
  wrap.append(input);
  return { wrap, input };
}

function windowFrame(title) {
  closeDialog();
  dialog = el('dialog', 'social-dialog social-governance-dialog');
  dialog.dataset.socialGovernance = 'true';
  const windowNode = el('section', 'social-window');
  const bar = el('header', 'social-titlebar');
  bar.append(el('strong', '', title), action('Close', closeDialog, 'social-close'));
  const body = el('div', 'social-window-body');
  const message = el('p', 'social-dialog-status');
  message.setAttribute('role', 'status');
  message.setAttribute('aria-live', 'polite');
  message.hidden = true;
  windowNode.append(bar, body);
  dialog.append(windowNode);
  document.body.append(dialog);
  if (dialog.showModal) dialog.showModal(); else dialog.setAttribute('open', '');
  return { windowNode, body, message };
}

function setMessage(message, text, tone = '') {
  message.textContent = text;
  message.dataset.tone = tone;
  message.hidden = !text;
}

async function mutate({ op, body, message, pending, success, refresh = true }) {
  setMessage(message, pending);
  try {
    const result = await request(op, { method: op === 'post' && body?.postId ? 'PATCH' : 'POST', body });
    setMessage(message, success, 'good');
    if (refresh) await window.SidewaysSocial?.refresh?.();
    return result;
  } catch (error) {
    setMessage(message, explainError(error, success.replace(/\.$/, '')), 'error');
    return null;
  }
}

function membershipRole(community) {
  const membership = community?.membership || community?.community?.membership || null;
  return membership?.status === 'active' && ROLES.has(membership.role) ? membership.role : '';
}

function communityValue(data) {
  return data?.community || data;
}

function renderPosts(posts, host, { thread = false } = {}) {
  host.replaceChildren();
  if (!posts?.length) {
    host.append(el('p', 'social-empty', thread ? 'No replies yet.' : 'No community posts yet.'));
    return;
  }
  for (const post of posts) {
    const article = el('article', 'social-governance-post');
    article.dataset.postId = post.id || post.postId || '';
    const handle = post.author?.handle || post.authorHandle || post.handle || 'unknown';
    article.append(el('strong', '', `@${handle}`), el('p', '', post.text || post.visibleText || post.summary || ''));
    host.append(article);
  }
}

async function openThread(record) {
  const postId = record?.social?.postId;
  if (!postId) return;
  const { windowNode, body, message } = windowFrame('Conversation');
  const list = el('div', 'social-governance-list');
  body.append(message, list);
  const reply = field('Reply in this thread', { type: 'textarea', rows: 4 });
  body.append(reply.wrap);
  const footer = el('footer', 'social-window-footer');
  footer.append(action('Reply', async () => {
    const result = await mutate({ op: 'post', body: { text: reply.input.value, replyTo: postId }, message, pending: 'Publishing reply…', success: 'Reply published.' });
    if (result) await openThread(record);
  }, 'social-primary'));
  windowNode.append(footer);
  setMessage(message, 'Loading authoritative thread…');
  try {
    const data = await request('thread', { query: { postId } });
    const posts = Array.isArray(data) ? data : (data.posts || data.thread || [data.root, ...(data.replies || [])].filter(Boolean));
    renderPosts(posts, list, { thread: true });
    setMessage(message, `Loaded ${posts.length} thread item${posts.length === 1 ? '' : 's'}.`, 'good');
  } catch (error) {
    setMessage(message, explainError(error, 'Thread view'), 'error');
  }
}

async function editPost(record) {
  if (!record?.social?.mine || !record.social.postId) return;
  const { windowNode, body, message } = windowFrame('Edit public post');
  const text = field('Public text', { type: 'textarea', value: record.text || record.summary || '', rows: 7 });
  const reason = field('Edit note', { placeholder: 'Optional public edit reason' });
  body.append(el('p', 'social-boundary-note', 'This edits the server-backed public post only. Your private archive record is separate and will not be changed.'), text.wrap, reason.wrap, message);
  const footer = el('footer', 'social-window-footer');
  footer.append(action('Save public edit', async () => {
    await mutate({ op: 'post', body: { postId: record.social.postId, text: text.input.value, reason: reason.input.value }, message, pending: 'Saving authoritative public edit…', success: 'Public post edited. Private archive unchanged.' });
  }, 'social-primary'));
  windowNode.append(footer);
  setTimeout(() => text.input.focus(), 30);
}

async function reportPost(record) {
  if (!window.SidewaysSocial?.account?.() || !record?.social?.postId || record.social.mine) return;
  const { windowNode, body, message } = windowFrame('Report public post');
  const kind = selectField('Reason', ['spam', 'harassment', 'misinformation', 'other']);
  const note = field('Evidence note', { type: 'textarea', rows: 5, placeholder: 'Describe what should be reviewed' });
  body.append(kind.wrap, note.wrap, message);
  const footer = el('footer', 'social-window-footer');
  footer.append(action('Submit report', async () => {
    await mutate({ op: 'report', body: { postId: record.social.postId, kind: kind.input.value, evidence: { note: note.input.value } }, message, pending: 'Submitting report…', success: 'Report submitted for authoritative review.', refresh: false });
  }, 'social-primary'));
  windowNode.append(footer);
}

async function setViewerControl(record, kind, active = true) {
  if (!window.SidewaysSocial?.account?.() || !record?.social?.authorHandle || record.social.mine) return;
  const targetId = record.social.authorHandle;
  const label = kind === 'block' ? 'Block' : 'Mute';
  if (!window.confirm(`${label} @${targetId} in your server-backed public feed? Your private archive is unaffected.`)) return;
  try {
    await request('local-control', { method: 'POST', body: { targetType: 'account', targetId, kind, active } });
    socialStatus(`${label} applied to @${targetId}. Private archive unchanged.`, 'good');
    await window.SidewaysSocial?.refresh?.();
  } catch (error) {
    socialStatus(explainError(error, `${label} control`), 'error');
  }
}

function appendModerationControls({ body, message, slug, role }) {
  if (!['moderator', 'owner'].includes(role)) return;
  const section = el('section', 'social-governance-section');
  section.append(el('h3', '', 'Moderation authority'));
  const targetType = selectField('Target type', ['post', 'member']);
  const targetId = field('Target ID or member handle');
  const actionName = selectField('Action', ['remove', 'restore', 'lock', 'unlock', 'ban', 'unban']);
  const reason = field('Reason', { type: 'textarea', rows: 3 });
  section.append(targetType.wrap, targetId.wrap, actionName.wrap, reason.wrap,
    action('Apply moderation', async () => {
      if (!window.confirm(`Apply ${actionName.input.value} to this ${targetType.input.value}?`)) return;
      await mutate({ op: 'moderate', body: { slug, targetType: targetType.input.value, targetId: targetId.input.value, action: actionName.input.value, reason: reason.input.value }, message, pending: 'Applying moderation…', success: 'Authoritative moderation state refreshed.' });
    }, 'social-primary'));
  body.append(section);
}

function appendAppealControls({ body, message, role }) {
  const section = el('section', 'social-governance-section');
  section.append(el('h3', '', 'Appeals'));
  const caseId = field('Moderation case ID');
  const appealText = field('Appeal', { type: 'textarea', rows: 4 });
  section.append(caseId.wrap, appealText.wrap, action('Submit appeal', async () => {
    await mutate({ op: 'appeal', body: { caseId: caseId.input.value, text: appealText.input.value }, message, pending: 'Submitting immutable appeal…', success: 'Appeal submitted.', refresh: false });
  }, 'social-secondary'));
  if (['moderator', 'owner'].includes(role)) {
    const appealId = field('Appeal ID');
    const decision = selectField('Decision', ['uphold', 'reverse']);
    const reason = field('Decision reason', { type: 'textarea', rows: 3 });
    section.append(appealId.wrap, decision.wrap, reason.wrap, action('Decide appeal', async () => {
      if (!window.confirm(`Record the ${decision.input.value} decision?`)) return;
      await mutate({ op: 'appeal-decide', body: { appealId: appealId.input.value, decision: decision.input.value, reason: reason.input.value }, message, pending: 'Recording appeal decision…', success: 'Appeal decision recorded.', refresh: false });
    }, 'social-primary'));
  }
  body.append(section);
}

function appendRoleControls({ body, message, slug, role }) {
  if (role !== 'owner') return;
  const section = el('section', 'social-governance-section');
  section.append(el('h3', '', 'Owner controls'));
  const handle = field('Member handle');
  const nextRole = selectField('Role', ['member', 'moderator', 'owner']);
  section.append(handle.wrap, nextRole.wrap, action('Set role', async () => {
    await mutate({ op: 'community-role', body: { slug, handle: handle.input.value, role: nextRole.input.value }, message, pending: 'Updating community role…', success: 'Community role updated.' });
  }, 'social-primary'));
  body.append(section);
}

function appendForkControls({ body, message, slug }) {
  const section = el('section', 'social-governance-section');
  section.append(el('h3', '', 'Fork this community'));
  const newSlug = field('New slug');
  const name = field('New name');
  const description = field('Description', { type: 'textarea', rows: 3 });
  section.append(newSlug.wrap, name.wrap, description.wrap, action('Create fork', async () => {
    await mutate({ op: 'community-fork', body: { slug, newSlug: newSlug.input.value, name: name.input.value, description: description.input.value }, message, pending: 'Forking community…', success: 'Community fork created.' });
  }, 'social-secondary'));
  body.append(section);
}

async function openCommunity(slugValue = '') {
  const { windowNode, body, message } = windowFrame('Community');
  const slugField = field('Community slug', { value: slugValue, placeholder: 'example-community' });
  const header = el('section', 'social-governance-section');
  const details = el('div', 'social-community-details');
  const feed = el('div', 'social-governance-list');
  header.append(slugField.wrap, action('Open community', () => void loadCommunity(), 'social-primary'), details);
  body.append(header, feed, message);
  const footer = el('footer', 'social-window-footer');
  windowNode.append(footer);

  async function loadCommunity() {
    const slug = slugField.input.value.trim();
    if (!slug) { setMessage(message, 'Enter a community slug.', 'error'); return; }
    setMessage(message, 'Loading authoritative community…');
    details.replaceChildren();
    feed.replaceChildren();
    footer.replaceChildren();
    try {
      const [rawCommunity, rawFeed] = await Promise.all([
        request('community', { query: { slug } }),
        request('community-feed', { query: { slug } })
      ]);
      const community = communityValue(rawCommunity);
      const role = membershipRole(community);
      details.append(el('h2', '', community.name || `c/${slug}`), el('p', '', community.description || ''), el('p', 'social-authority-label', role ? `Your role: ${role}` : 'Viewer — not a member'));
      renderPosts(rawFeed.posts || [], feed);
      if (window.SidewaysSocial?.account?.()) {
        footer.append(action(role ? 'Leave' : 'Join', async () => {
          await mutate({ op: 'community-member', body: { slug, active: !role }, message, pending: role ? 'Leaving community…' : 'Joining community…', success: role ? 'Left community.' : 'Joined community.' });
          await loadCommunity();
        }, 'social-primary'));
        footer.append(action('Post here', () => openCommunityPost(slug), 'social-secondary'));
        appendForkControls({ body, message, slug });
        appendRoleControls({ body, message, slug, role });
        appendModerationControls({ body, message, slug, role });
        appendAppealControls({ body, message, role });
      }
      setMessage(message, `Community projection loaded${role ? ` as ${role}` : ''}.`, 'good');
    } catch (error) {
      setMessage(message, explainError(error, 'Community view'), 'error');
    }
  }

  if (slugValue) void loadCommunity(); else setTimeout(() => slugField.input.focus(), 30);
}

function openCommunityPost(slug) {
  const { windowNode, body, message } = windowFrame(`Post to c/${slug}`);
  const text = field('Public post', { type: 'textarea', rows: 7 });
  body.append(text.wrap, message);
  const footer = el('footer', 'social-window-footer');
  footer.append(action('Publish to community', async () => {
    const result = await mutate({ op: 'post', body: { text: text.input.value, community: slug }, message, pending: 'Publishing to community…', success: 'Community post published.' });
    if (result) setTimeout(() => openCommunity(slug), 250);
  }, 'social-primary'));
  windowNode.append(footer);
}

function openCreateCommunity() {
  if (!window.SidewaysSocial?.account?.()) { window.SidewaysSocial?.login?.(); return; }
  const { windowNode, body, message } = windowFrame('Create community');
  const name = field('Community name');
  const slug = field('Slug');
  const description = field('Description', { type: 'textarea', rows: 5 });
  const rules = field('Rules (JSON object)', { type: 'textarea', value: '{}', rows: 5 });
  body.append(name.wrap, slug.wrap, description.wrap, rules.wrap, message);
  const footer = el('footer', 'social-window-footer');
  footer.append(action('Create community', async () => {
    let parsedRules;
    try { parsedRules = JSON.parse(rules.input.value || '{}'); }
    catch { setMessage(message, 'Rules must be a JSON object.', 'error'); return; }
    if (!parsedRules || Array.isArray(parsedRules) || typeof parsedRules !== 'object') { setMessage(message, 'Rules must be a JSON object.', 'error'); return; }
    const result = await mutate({ op: 'community', body: { name: name.input.value, slug: slug.input.value, description: description.input.value, rules: parsedRules }, message, pending: 'Creating community…', success: 'Community created.' });
    if (result) setTimeout(() => openCommunity(result.community?.slug || result.slug || slug.input.value), 250);
  }, 'social-primary'));
  windowNode.append(footer);
}

function openCommunityHub() {
  const { windowNode, body, message } = windowFrame('Public communities');
  body.append(el('p', 'social-boundary-note', 'Community, moderation, appeal, and viewer controls are server-backed. Static and Blob-only deployments report them unavailable and never simulate success.'), message);
  const footer = el('footer', 'social-window-footer');
  footer.append(action('Open by slug', () => openCommunity(), 'social-primary'));
  if (window.SidewaysSocial?.account?.()) footer.append(action('Create community', openCreateCommunity, 'social-secondary'));
  windowNode.append(footer);
}

function ensureHubButton() {
  const actions = document.querySelector('[data-social-spine] .social-spine-actions');
  if (!actions || actions.querySelector('[data-action-id="social.communities"]')) return;
  const button = action('COMMUNITIES', openCommunityHub, 'social-command');
  button.dataset.actionId = 'social.communities';
  actions.append(button);
}

async function decorateCard(card) {
  const recordId = Number(card.dataset.id || 0);
  if (!recordId) return;
  const record = await Workspace.getRecord(recordId);
  if (!record?.social?.postId) return;
  const footer = card.querySelector('.actions');
  if (!footer) return;
  if (!footer.querySelector('[data-action-id="social.thread"]')) {
    const thread = action('Thread', event => { event.preventDefault(); event.stopImmediatePropagation(); void openThread(record); }, 'frontier-action');
    thread.dataset.actionId = 'social.thread';
    footer.append(thread);
  }
  if (record.social.mine && !footer.querySelector('[data-action-id="social.post.edit"]')) {
    const edit = action('Edit', event => { event.preventDefault(); event.stopImmediatePropagation(); void editPost(record); }, 'frontier-action');
    edit.dataset.actionId = 'social.post.edit';
    footer.append(edit);
  }
  if (window.SidewaysSocial?.account?.() && !record.social.mine) {
    if (!footer.querySelector('[data-action-id="social.report"]')) {
      const report = action('Report', event => { event.preventDefault(); event.stopImmediatePropagation(); void reportPost(record); }, 'frontier-action');
      report.dataset.actionId = 'social.report';
      footer.append(report);
    }
    for (const kind of ['mute', 'block']) {
      if (footer.querySelector(`[data-action-id="social.${kind}"]`)) continue;
      const button = action(kind === 'mute' ? 'Mute' : 'Block', event => { event.preventDefault(); event.stopImmediatePropagation(); void setViewerControl(record, kind, true); }, 'frontier-action');
      button.dataset.actionId = `social.${kind}`;
      footer.append(button);
    }
  }
}

async function decorate() {
  ensureHubButton();
  await Promise.all([...document.querySelectorAll('#feed .post')].map(decorateCard));
}

function queueDecorate() {
  if (decorateQueued) return;
  decorateQueued = true;
  requestAnimationFrame(() => {
    decorateQueued = false;
    void decorate();
  });
}

for (const name of ['sideways:ready', 'sideways:feedrender', 'sideways:corpusrefresh', 'hashchange', 'popstate']) window.addEventListener(name, queueDecorate);
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', queueDecorate, { once: true });
else queueDecorate();

window.SidewaysSocialGovernance = Object.freeze({ open: openCommunityHub, community: openCommunity, thread: openThread, refresh: queueDecorate });
