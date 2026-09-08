import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

const REPO = "Pokitomas/theawesomehexapp";
const BRANCH = "mach-live-bus";
const API = `https://api.github.com/repos/${REPO}/contents`;
const GH = process.env.MACH_GITHUB_TOKEN ?? "";
const BUS = Buffer.from(process.env.MACH_BUS_TOKEN ?? "", "utf8");

function requireSecrets() {
  if (GH.length < 20 || BUS.length < 32) throw new Error("Mach transport secrets are unavailable");
}

function b64url(buf: Buffer) {
  return buf.toString("base64url");
}

function from64(s: string) {
  return Buffer.from(s, "base64url");
}

function key(label: string) {
  return createHmac("sha256", BUS).update(label).digest();
}

function stream(k: Buffer, nonce: Buffer, length: number) {
  const parts: Buffer[] = [];
  let total = 0;
  let counter = 0;
  while (total < length) {
    const c = Buffer.alloc(8);
    c.writeBigUInt64BE(BigInt(counter++));
    const part = createHmac("sha256", k).update(Buffer.concat([nonce, c])).digest();
    parts.push(part);
    total += part.length;
  }
  return Buffer.concat(parts).subarray(0, length);
}

export function seal(value: unknown) {
  requireSecrets();
  const plain = Buffer.from(JSON.stringify(value), "utf8");
  const nonce = randomBytes(16);
  const ks = stream(key("mach-live-bus/enc/v1"), nonce, plain.length);
  const cipher = Buffer.alloc(plain.length);
  for (let i = 0; i < plain.length; i++) cipher[i] = plain[i] ^ ks[i];
  const tag = createHmac("sha256", key("mach-live-bus/mac/v1"))
    .update(Buffer.concat([nonce, cipher]))
    .digest()
    .subarray(0, 16);
  return b64url(Buffer.concat([nonce, cipher, tag]));
}

export function unseal(box: string) {
  requireSecrets();
  const raw = from64(box);
  if (raw.length < 32) throw new Error("bad Mach response box");
  const nonce = raw.subarray(0, 16);
  const cipher = raw.subarray(16, raw.length - 16);
  const tag = raw.subarray(raw.length - 16);
  const want = createHmac("sha256", key("mach-live-bus/mac/v1"))
    .update(Buffer.concat([nonce, cipher]))
    .digest()
    .subarray(0, 16);
  if (!timingSafeEqual(tag, want)) throw new Error("Mach response authentication failed");
  const ks = stream(key("mach-live-bus/enc/v1"), nonce, cipher.length);
  const plain = Buffer.alloc(cipher.length);
  for (let i = 0; i < cipher.length; i++) plain[i] = cipher[i] ^ ks[i];
  return JSON.parse(plain.toString("utf8"));
}

type Content = { sha: string; content: string };

async function gh(path: string): Promise<Content> {
  requireSecrets();
  const r = await fetch(`${API}/${path}?ref=${encodeURIComponent(BRANCH)}&t=${Date.now()}`, {
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${GH}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "mach-mcp-facade/1",
    },
  });
  if (!r.ok) throw new Error(`GitHub read ${path}: ${r.status}`);
  return (await r.json()) as Content;
}

function decode<T = any>(obj: Content): T {
  return JSON.parse(Buffer.from(obj.content.replace(/\n/g, ""), "base64").toString("utf8"));
}

async function put(path: string, value: unknown, sha: string, message: string) {
  const r = await fetch(`${API}/${path}`, {
    method: "PUT",
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${GH}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "mach-mcp-facade/1",
    },
    body: JSON.stringify({
      message,
      branch: BRANCH,
      sha,
      content: Buffer.from(`${JSON.stringify(value)}\n`, "utf8").toString("base64"),
    }),
  });
  if (!r.ok) {
    const body = await r.text();
    const err = new Error(`GitHub write ${path}: ${r.status} ${body.slice(0, 300)}`) as Error & { status?: number };
    err.status = r.status;
    throw err;
  }
  return (await r.json()) as any;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquire(owner: string, maxWaitMs = 15000) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const cur = await gh("mcp-lock.json");
    const lock = decode<{ owner?: string | null; expires?: number }>(cur);
    if (!lock.owner || Number(lock.expires ?? 0) < Date.now() || lock.owner === owner) {
      try {
        await put("mcp-lock.json", { owner, expires: Date.now() + 75000 }, cur.sha, "mcp acquire");
        return;
      } catch (e: any) {
        if (e?.status !== 409 && e?.status !== 422) throw e;
      }
    }
    await sleep(220);
  }
  throw new Error("Mach transport busy");
}

async function release(owner: string) {
  try {
    const cur = await gh("mcp-lock.json");
    const lock = decode<{ owner?: string | null }>(cur);
    if (lock.owner === owner) await put("mcp-lock.json", { owner: null, expires: 0 }, cur.sha, "mcp release");
  } catch {
    // Lease expiry is the fallback release.
  }
}

export async function callMach(payload: Record<string, unknown>, timeoutMs = 60000) {
  const owner = randomUUID();
  await acquire(owner);
  try {
    let seq = 0;
    for (let attempt = 0; attempt < 8; attempt++) {
      const cur = await gh("inbox.json");
      const inbox = decode<{ seq?: number }>(cur);
      seq = Number(inbox.seq ?? 0) + 1;
      const next = {
        schema: "mach-live-bus/v1",
        seq,
        from: "mach-mcp",
        box: seal(payload),
        ts: Date.now() / 1000,
      };
      try {
        await put("inbox.json", next, cur.sha, `mcp seq ${seq}`);
        break;
      } catch (e: any) {
        if ((e?.status === 409 || e?.status === 422) && attempt < 7) continue;
        throw e;
      }
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const cur = await gh("outbox.json");
      const out = decode<{ ack?: number; box?: string }>(cur);
      const ack = Number(out.ack ?? 0);
      if (ack === seq && out.box) return unseal(out.box);
      if (ack > seq) throw new Error(`Mach response ${seq} was overtaken by ${ack}`);
      await sleep(350);
    }
    throw new Error(`Mach timeout waiting for seq ${seq}`);
  } finally {
    await release(owner);
  }
}
