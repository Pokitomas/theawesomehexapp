self.onmessage = async event => {
  const { id, file } = event.data || {};
  try {
    const buffer = await file.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    const hex = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    self.postMessage({ id, digest: hex });
  } catch (error) {
    self.postMessage({ id, error: error?.message || String(error) });
  }
};
