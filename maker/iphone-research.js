export const IPHONE_RESEARCH_MARKER = '[archie-iphone-primary/v1]';
export const IPHONE_RESEARCH_PROFILE = Object.freeze({
  schema: 'archie-iphone-research-focus/v1',
  primary_device: 'iphone-a15-4gb-floor',
  desktop_role: 'fallback-and-development-only',
  allocation: Object.freeze({ iphone_model_quality_and_quantization: 1, desktop_specific_research: 0 }),
  quantization_search: Object.freeze([
    'mlx-grouped-4bit', 'mlx-grouped-6bit', 'coreml-palettization-4bit',
    'coreml-palettization-6bit', 'coreml-linear-weight-4bit', 'coreml-linear-weight-8bit'
  ]),
  selection: 'quality-first-subject-to-physical-iphone-memory-latency-power-thermal-and-sustained-throughput-gates',
  evidence: 'exact-physical-iphone-floor-required',
  training_spend: 'human'
});

const clean = (value, limit = 20000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);

export function applyIPhoneResearchDirective(request) {
  const original = clean(request, 8000);
  if (!original || original.includes(IPHONE_RESEARCH_MARKER)) return original;
  return [
    original,
    '',
    IPHONE_RESEARCH_MARKER,
    'Treat the iPhone A15 / 4 GB device floor as the primary product and desktop as a fallback development surface.',
    'Allocate all authorized research effort in this session to model quality, compression, and exact physical-iPhone evidence.',
    'Compare MLX grouped 4/6-bit and Core ML 4/6/8-bit candidates; select quality-first only after memory, latency, sustained throughput, power, and thermal gates pass.',
    'Do not start paid training, promote a model, merge, or deploy without the existing human approvals and exact receipts.'
  ].join('\n').slice(0, 8000);
}

function findReceiptBlock(body) {
  const matches = [...String(body || '').matchAll(/```json\s*([\s\S]*?)```/gi)];
  for (const match of matches.reverse()) {
    try {
      const receipt = JSON.parse(match[1]);
      if (receipt?.version === 'sideways-maker/v1') return { match, receipt };
    } catch {}
  }
  return null;
}

export function patchMakerIssueHref(href) {
  const url = new URL(href);
  const body = url.searchParams.get('body');
  if (!body) return url.toString();
  const found = findReceiptBlock(body);
  if (!found) return url.toString();
  const receipt = {
    ...found.receipt,
    request: applyIPhoneResearchDirective(found.receipt.request),
    device_requirement: 'iphone-primary-a15-4gb-floor-and-desktop-fallback',
    research_focus: IPHONE_RESEARCH_PROFILE
  };
  const replacement = `\`\`\`json\n${JSON.stringify(receipt, null, 2)}\n\`\`\``;
  const start = found.match.index;
  url.searchParams.set('body', `${body.slice(0, start)}${replacement}${body.slice(start + found.match[0].length)}`);
  return url.toString();
}

export function receiptFromMakerIssueHref(href) {
  const body = new URL(href).searchParams.get('body') || '';
  return findReceiptBlock(body)?.receipt || null;
}

export function mountIPhoneResearchProfile(doc = document) {
  const send = doc.querySelector('#send-command');
  const preview = doc.querySelector('#receipt-preview');
  const status = doc.querySelector('#command-status');
  const copy = doc.querySelector('#copy-receipt');
  if (!send) return () => {};
  let applying = false;
  const apply = () => {
    if (applying || !send.href) return;
    applying = true;
    try {
      const patched = patchMakerIssueHref(send.href);
      if (send.href !== patched) send.href = patched;
      const receipt = receiptFromMakerIssueHref(patched);
      if (preview && receipt) preview.textContent = `${JSON.stringify(receipt, null, 2)}\n`;
      if (status && receipt?.research_focus) status.textContent = 'Saved locally · iPhone primary · training spend still human-only.';
      doc.documentElement.dataset.iphonePrimary = 'true';
    } finally {
      applying = false;
    }
  };
  const schedule = () => queueMicrotask(apply);
  for (const event of ['input', 'change', 'click']) doc.addEventListener(event, schedule);
  copy?.addEventListener('click', () => queueMicrotask(async () => {
    const receipt = send.href ? receiptFromMakerIssueHref(patchMakerIssueHref(send.href)) : null;
    if (receipt && navigator.clipboard?.writeText) await navigator.clipboard.writeText(`${JSON.stringify(receipt, null, 2)}\n`).catch(() => {});
  }));
  const observer = new MutationObserver(schedule);
  observer.observe(send, { attributes: true, attributeFilter: ['href'] });
  schedule();
  return () => {
    for (const event of ['input', 'change', 'click']) doc.removeEventListener(event, schedule);
    observer.disconnect();
  };
}

if (typeof document !== 'undefined') mountIPhoneResearchProfile(document);
