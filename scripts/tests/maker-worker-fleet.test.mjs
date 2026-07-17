import e from "node:assert/strict";
import t from "node:fs/promises";
import a from "node:test";
import {
  WorkerFleetError as s,
  createWorkerAdapterRegistry as r,
  createWorkerFleet as o,
  fleetDigest as i,
  normalizeArtifactReferences as n,
  normalizeFleetTask as c,
  normalizeWorkerDescriptor as d,
  rankWorkers as l,
  redactFleetSecrets as u,
  registerDefaultWorkerAdapters as p,
  scoreWorker as m,
} from "../maker-worker-fleet.mjs";
const h = (e) => `sha256:${e.repeat(64)}`;
function k(e, t) {
  const a = { schema: e, ...t };
  return { ...a, digest: `sha256:${i(a)}` };
}
function _(e = "worker") {
  return {
    ownership: "user",
    transport: "local",
    locality: "local",
    capacity: "dedicated",
    throttling: "none",
    label: "Your local Maker runtime",
    endpoint_digest: h("e"),
  };
}
function y(e, t = {}) {
  const a = t.mode || "in_process",
    s = { ..._(e), ...(t.endpoint || {}) },
    r = `worker:${e}`,
    o = k("sideways-maker-worker-attestation/v1", {
      worker_id: e,
      subject: r,
      mode: a,
      endpoint_digest: s.endpoint_digest,
      issuer: "maker-owner",
      issued_at: "2026-07-15T00:00:00.000Z",
    }),
    i = k("sideways-maker-worker-health/v1", {
      worker_id: e,
      endpoint_digest: s.endpoint_digest,
      state: "healthy",
      issuer: "maker-probe",
      observed_at: "2026-07-15T00:00:00.000Z",
    });
  return {
    id: e,
    display_name: e,
    identity: {
      status: "attested",
      subject: r,
      issuer: "maker-owner",
      receipt: o,
    },
    mode: a,
    platform: { os: "linux", architecture: "x64" },
    labels: ["node22", "repair", "recovery"],
    capabilities: ["coding", "git", "browser"],
    toolchains: ["node", "git"],
    providers: ["adaptive"],
    models: ["maker-engine"],
    network: { mode: "egress", allowed_hosts: ["github.com"] },
    isolation: { container: !0, sandbox: !0, ephemeral_workspace: !0 },
    resources: { cpu: 8, memory_mb: 16384, disk_mb: 1e5, time_ms: 72e5 },
    concurrency: { limit: 2, active: 0, queue_depth: 0 },
    endpoint: s,
    region: "us-west",
    privacy: "local",
    cost: { per_minute_usd: 0.01, per_job_usd: 0.1 },
    latency_ms: 20,
    health: {
      state: "healthy",
      observed_at: "2026-07-15T00:00:00.000Z",
      receipt: i,
    },
    operator_state: "active",
    reliability: { successes: 9, failures: 1, lost: 0 },
    recovery: { checkpointing: !0, mode: "checkpoint" },
    ...t,
    endpoint: s,
    identity: t.identity || {
      status: "attested",
      subject: r,
      issuer: "maker-owner",
      receipt: o,
    },
    health: t.health || {
      state: "healthy",
      observed_at: "2026-07-15T00:00:00.000Z",
      receipt: i,
    },
  };
}
function w(e = {}) {
  return {
    id: "task-1",
    owner: "Pokitomas",
    repository: "Pokitomas/theawesomehexapp",
    backend: "auto",
    priority: 50,
    capabilities: ["coding", "git"],
    labels: ["node22"],
    toolchains: ["node", "git"],
    providers: ["adaptive"],
    models: ["maker-engine"],
    modes: ["in_process"],
    platform: { os: "linux", architecture: "x64" },
    network: "egress",
    allowed_hosts: ["github.com"],
    isolation: { container: !0, sandbox: !0, ephemeral_workspace: !0 },
    resources: { cpu: 2, memory_mb: 2048, disk_mb: 2048, time_ms: 6e4 },
    region: "us-west",
    locality: "local",
    privacy: "local",
    dedicated_capacity: !0,
    recoverable: !0,
    max_latency_ms: 100,
    max_cost_usd: 10,
    ...e,
  };
}
function f() {
  let e = Date.parse("2026-07-15T00:00:00.000Z"),
    t = 0;
  return {
    clock: () => e,
    id: () => "id-" + ++t,
    advance: (t) => {
      e += t;
    },
  };
}
function v(e = { in_process: async (e) => ({ accepted: e.task.id }) }, t = {}) {
  const a = r(t);
  return (p(a, e), a);
}
(a(
  "descriptors cover all worker modes with digest-bound identity and health",
  () => {
    for (const t of [
      "github_actions",
      "self_hosted",
      "remote_http",
      "in_process",
      "local_control",
    ]) {
      const a = d(y(t, { mode: t }));
      (e.equal(a.mode, t),
        e.equal(a.identity.trusted, !0),
        e.equal(a.health.evidence, "observed"),
        e.match(a.descriptor_digest, /^[a-f0-9]{64}$/));
    }
  },
),
  a(
    "verified labels and digest-shaped strings cannot self-assert trust",
    () => {
      const t = d(
        y("fake", {
          identity: {
            status: "verified",
            subject: "worker:fake",
            receipt: {
              schema: "sideways-maker-worker-attestation/v1",
              digest: h("a"),
            },
          },
        }),
      );
      (e.equal(t.identity.trusted, !1),
        e.ok(m(t, c(w())).reasons.includes("identity_unverified")));
    },
  ),
  a("attestation is bound to worker, mode, subject, and endpoint", () => {
    const t = y("bound");
    (e.equal(d(t).identity.trusted, !0),
      e.equal(d({ ...t, mode: "remote_http" }).identity.trusted, !1),
      e.equal(
        d({ ...t, endpoint: { ...t.endpoint, endpoint_digest: h("z") } })
          .identity.trusted,
        !1,
      ));
  }),
  a(
    "healthy labels without observed health receipt cannot create capacity",
    () => {
      const t = y("unobserved", { health: { state: "healthy" } }),
        a = d(t);
      (e.equal(a.health.evidence, "unknown"),
        e.ok(m(a, c(w())).reasons.includes("health_unobserved")));
    },
  ),
  a(
    "unknown resources, cost, latency, privacy, and locality fail closed",
    () => {
      const t = d({
          id: "sparse",
          mode: "in_process",
          identity: { status: "unverified" },
          endpoint: { endpoint_digest: h("s") },
          health: { state: "unknown" },
        }),
        a = m(t, c(w({ allow_unverified: !0 }))).reasons;
      for (const t of [
        "health_unobserved",
        "cpu_unknown",
        "memory_mb_unknown",
        "disk_mb_unknown",
        "time_ms_unknown",
        "concurrency_unknown",
        "privacy_mismatch",
        "latency_unknown",
        "cost_unknown",
      ])
        e.ok(a.includes(t), t);
    },
  ),
  a(
    "hard capability, platform, network, isolation, resource, capacity, and recovery constraints fail closed",
    () => {
      const t = d(y("hard"));
      e.equal(m(t, c(w())).eligible, !0);
      const a = [
        [w({ capabilities: ["gpu"] }), "capability_mismatch"],
        [
          w({ platform: { os: "windows", architecture: "x64" } }),
          "os_mismatch",
        ],
        [w({ network: "full" }), "network_mismatch"],
        [w({ allowed_hosts: ["example.com"] }), "network_host_mismatch"],
        [
          w({
            resources: {
              cpu: 100,
              memory_mb: 2048,
              disk_mb: 2048,
              time_ms: 6e4,
            },
          }),
          "cpu_insufficient",
        ],
        [
          w({ capacity: "shared", dedicated_capacity: !1 }),
          "capacity_mismatch",
        ],
        [w({ recoverable: !0 }), null],
      ];
      for (const [s, r] of a) {
        const a = m(t, c(s));
        r ? e.ok(a.reasons.includes(r), r) : e.equal(a.eligible, !0);
      }
    },
  ),
  a(
    "deterministic ranking uses reliability, load, privacy, locality, latency, cost, and operator preference",
    () => {
      const t = d(y("a-fast", { operator_weight: 10 })),
        a = d(
          y("z-slow", {
            endpoint: { ..._("z"), locality: "remote", capacity: "shared" },
            privacy: "provider",
            latency_ms: 500,
            concurrency: { limit: 4, active: 1, queue_depth: 5 },
            cost: { per_minute_usd: 2, per_job_usd: 3 },
            reliability: { successes: 1, failures: 5, lost: 1 },
          }),
        ),
        s = c(
          w({ locality: "any", privacy: "provider", dedicated_capacity: !1 }),
        ),
        r = l([a, t], s),
        o = l([t, a], s);
      (e.equal(r[0].worker.id, "a-fast"),
        e.deepEqual(
          r.map((e) => [e.worker.id, e.score]),
          o.map((e) => [e.worker.id, e.score]),
        ));
    },
  ),
  a(
    "no-placement classification distinguishes empty, mismatch, trust, health, quota, cost, and infrastructure",
    () => {
      const t = f();
      (e.throws(
        () => o({ adapters: v() }).place(w()),
        (e) => "capacity_unavailable" === e.code,
      ),
        e.throws(
          () =>
            o({ workers: [y("m")], adapters: v() }).place(
              w({ capabilities: ["gpu"] }),
            ),
          (e) => "capability_mismatch" === e.code,
        ),
        e.throws(
          () =>
            o({
              workers: [y("u", { identity: { status: "unverified" } })],
              adapters: v(),
            }).place(w()),
          (e) => "unverified_identity" === e.code,
        ),
        e.throws(
          () =>
            o({
              workers: [y("h", { health: { state: "healthy" } })],
              adapters: v(),
            }).place(w()),
          (e) => "unhealthy_worker" === e.code,
        ),
        e.throws(
          () =>
            o({
              workers: [y("q")],
              adapters: v(),
              quotas: {
                "repository:Pokitomas/theawesomehexapp": { concurrency: 0 },
              },
            }).place(w()),
          (e) => "quota_exhausted" === e.code,
        ));
      const a = y("cost");
      (delete a.cost,
        e.throws(
          () => o({ workers: [a], adapters: v() }).place(w()),
          (e) => "cost_unknown" === e.code,
        ),
        e.throws(
          () => o({ workers: [y("i")], adapters: v({}) }).place(w()),
          (e) => "external_infrastructure_blocker" === e.code,
        ),
        e.equal(t.clock() > 0, !0));
    },
  ),
  a(
    "priority, owner fairness, starvation, and recovery reservation are deterministic",
    async () => {
      const t = f(),
        a = o({
          workers: [
            y("one", { concurrency: { limit: 2, active: 0, queue_depth: 0 } }),
          ],
          clock: t.clock,
          id: t.id,
          adapters: v(),
          starvation_ms: 1e3,
          recovery_reserve: 1,
        });
      (a.submit(
        w({
          id: "old",
          owner: "a",
          priority: 1,
          created_at: new Date(t.clock()).toISOString(),
        }),
      ),
        t.advance(15e3),
        a.submit(w({ id: "new", owner: "b", priority: 90 })),
        a.submit(
          w({
            id: "repair",
            owner: "c",
            priority: 10,
            reservation: "recovery",
          }),
        ),
        e.equal((await a.schedule()).task.id, "repair"),
        e.equal((await a.schedule()).task.id, "old"),
        e.equal(a.listQueue()[0].task.id, "new"));
    },
  ),
  a(
    "leases fence stale writers, prevent duplicate execution, and heartbeat extends expiry",
    async () => {
      const t = f(),
        a = o({
          workers: [y("lease")],
          clock: t.clock,
          id: t.id,
          adapters: v(),
          lease_ms: 1e3,
        });
      a.submit(w());
      const s = await a.schedule();
      (e.equal(s.lease.fence, 1),
        e.throws(
          () => a.heartbeat(s.task.id, "wrong", 1),
          (e) => "lease_token_mismatch" === e.code,
        ),
        e.throws(
          () => a.heartbeat(s.task.id, s.lease.token, 99),
          (e) => "fence_mismatch" === e.code,
        ),
        t.advance(500));
      const r = a.heartbeat(s.task.id, s.lease.token, 1);
      (e.equal(Date.parse(r.lease.expires_at), t.clock() + 1e3),
        e.throws(
          () => a.place(s.task),
          (e) =>
            ["capability_mismatch", "capacity_unavailable"].includes(e.code),
        ));
    },
  ),
  a(
    "dispatch failure rolls back capacity and requeues instead of pretending work started",
    async () => {
      const t = o({
        workers: [y("dispatch")],
        adapters: v({
          in_process: async () => {
            throw new Error("transport down");
          },
        }),
      });
      t.submit(w());
      const a = await t.schedule();
      (e.equal(a.state, "dispatch_failed"),
        e.equal(t.getTask("task-1").state, "queued"),
        e.equal(t.getWorker("dispatch").concurrency.active, 0),
        e.equal(t.usage()["repository:Pokitomas/theawesomehexapp"].active, 0));
    },
  ),
  a(
    "dispatch timeout passes AbortSignal, marks indeterminate evidence, and releases reservations",
    async () => {
      let t = !1;
      const a = v(
          {
            in_process: (e) =>
              new Promise(() =>
                e.signal.addEventListener("abort", () => {
                  t = !0;
                }),
              ),
          },
          { timeout_ms: 5 },
        ),
        s = o({ workers: [y("timeout")], adapters: a, dispatch_timeout_ms: 5 });
      s.submit(w());
      const r = await s.schedule();
      (e.equal(r.state, "dispatch_failed"),
        e.equal(r.error.code, "dispatch_timeout"),
        e.equal(r.error.indeterminate, !0),
        e.equal(t, !0),
        e.equal(s.getWorker("timeout").concurrency.active, 0));
    },
  ),
  a(
    "artifact and log references require URI, digest, size, provenance, and reject payloads",
    () => {
      (e.throws(
        () => n({ artifacts: [{ uri: "artifact://x", size_bytes: 1 }] }),
        (e) => "artifact_digest_invalid" === e.code,
      ),
        e.throws(
          () => n({ artifacts: [{ digest: h("a"), size_bytes: 1 }] }),
          (e) => "artifact_uri_required" === e.code,
        ),
        e.throws(
          () => n({ artifacts: [{ uri: "artifact://x", digest: h("a") }] }),
          (e) => "artifact_size_required" === e.code,
        ),
        e.throws(
          () =>
            n({
              artifacts: [
                {
                  uri: "artifact://x",
                  digest: h("a"),
                  size_bytes: 1,
                  content: "raw",
                },
              ],
            }),
          (e) => "artifact_payload_denied" === e.code,
        ));
      const t = n({
        logs: [
          {
            uri: "log://x",
            digest: h("b"),
            size_bytes: 4,
            provenance: "worker",
          },
        ],
      });
      e.equal(t.logs[0].kind, "log");
    },
  ),
  a(
    "completion verifies actual task and scoped quota cost before accepting usage",
    async () => {
      const t = o({
        workers: [y("budget")],
        adapters: v(),
        quotas: {
          "repository:Pokitomas/theawesomehexapp": {
            concurrency: 2,
            cost_usd: 0.5,
          },
        },
      });
      t.submit(w({ max_cost_usd: 0.4 }));
      const a = await t.schedule();
      e.throws(
        () =>
          t.complete("task-1", a.lease.token, a.lease.fence, { cost_usd: 0.6 }),
        (e) => "task_budget_exhausted" === e.code,
      );
      const s = t.complete("task-1", a.lease.token, a.lease.fence, {
        cost_usd: 0.3,
        references: {
          artifacts: [
            {
              uri: "artifact://bundle",
              digest: h("c"),
              size_bytes: 12,
              provenance: "worker",
            },
          ],
        },
        detail: { authorization: "Bearer abcdefghijklmnopqrstuvwxyz" },
      });
      (e.equal(s.state, "completed"),
        e.equal(s.result.detail.authorization, "[redacted]"),
        e.equal(
          t.usage()["repository:Pokitomas/theawesomehexapp"].cost_usd,
          0.3,
        ));
    },
  ),
  a(
    "scoped quota reservation prevents concurrent cost oversubscription",
    async () => {
      const t = o({
        workers: [
          y("quota", { concurrency: { limit: 2, active: 0, queue_depth: 0 } }),
        ],
        adapters: v(),
        quotas: {
          "repository:Pokitomas/theawesomehexapp": {
            concurrency: 2,
            cost_usd: 0.2,
          },
        },
      });
      (t.submit(w({ id: "one", max_cost_usd: 1 })),
        t.submit(w({ id: "two", max_cost_usd: 1 })));
      const a = await t.schedule();
      (e.equal(a.state, "running"),
        e.equal(await t.schedule(), null),
        e.equal(t.getTask("two").last_error.code, "quota_exhausted"));
    },
  ),
  a("snapshot and ordinary execution reads redact lease tokens", async () => {
    const t = o({ workers: [y("secret")], adapters: v() });
    t.submit(w());
    const a = await t.schedule();
    (e.notEqual(a.lease.token, "[redacted]"),
      e.equal(t.getExecution("task-1").lease.token, "[redacted]"),
      e.equal(t.snapshot().executions[0].lease.token, "[redacted]"),
      e.ok(!JSON.stringify(t.snapshot()).includes(a.lease.token)));
  }),
  a(
    "recoverable and fatal failures release capacity and preserve attempt policy",
    async () => {
      const t = o({ workers: [y("fail")], adapters: v() });
      t.submit(w({ max_attempts: 2 }));
      const a = await t.schedule();
      (t.fail("task-1", a.lease.token, a.lease.fence, {
        code: "transient",
        message: "retry",
        recoverable: !0,
      }),
        e.equal(t.getTask("task-1").state, "queued"),
        e.equal(t.getTask("task-1").task.attempt, 2));
      const s = await t.schedule();
      (t.fail("task-1", s.lease.token, s.lease.fence, {
        code: "fatal",
        recoverable: !1,
      }),
        e.equal(t.getTask("task-1").state, "failed"),
        e.equal(t.getWorker("fail").concurrency.active, 0));
    },
  ),
  a(
    "expired heartbeats mark worker lost, fence the lease, and queue reserved recovery",
    async () => {
      const t = f(),
        a = o({
          workers: [y("lost")],
          adapters: v(),
          clock: t.clock,
          id: t.id,
          lease_ms: 1e3,
        });
      a.submit(w({ retry_lost: !0, max_attempts: 2 }));
      const s = await a.schedule();
      (t.advance(1001),
        e.deepEqual(a.recoverExpired(), ["task-1"]),
        e.equal(a.getTask("task-1").task.reservation, "recovery"),
        e.equal(a.getExecution("task-1").lease.token, "[redacted]"),
        e.equal(a.getWorker("lost").operator_state, "offline"),
        e.notEqual(s.lease.token, "[redacted]"));
    },
  ),
  a(
    "drain and quarantine are explicit while recovery requires a fresh observed health receipt",
    () => {
      const t = o({ workers: [y("ops")], adapters: v() });
      (e.equal(t.drain("ops", "maintenance").operator_state, "draining"),
        e.equal(
          t.quarantine("ops", "suspicious").operator_state,
          "quarantined",
        ),
        e.throws(
          () => t.recoverWorker("ops", { state: "healthy" }),
          (e) => "health_receipt_invalid" === e.code,
        ));
      const a = t.getWorker("ops"),
        s = t.recoverWorker(
          "ops",
          (function (e, t = "healthy") {
            const a = d(e);
            return {
              state: t,
              observed_at: "2026-07-15T01:00:00.000Z",
              receipt: k("sideways-maker-worker-health/v1", {
                worker_id: a.id,
                endpoint_digest: a.endpoint.endpoint_digest,
                state: t,
                issuer: "maker-probe",
                observed_at: "2026-07-15T01:00:00.000Z",
              }),
            };
          })(a),
          "verified",
        );
      (e.equal(s.operator_state, "active"),
        e.equal(s.health.evidence, "observed"));
    },
  ),
  a(
    "all adapter modes report availability and dispatch receipts redact secrets",
    async () => {
      const t = r();
      (p(t, {
        github_actions: async () => ({
          authorization: "Bearer abcdefghijklmnopqrstuvwxyz",
        }),
        self_hosted: async () => ({ ok: !0 }),
        remote_http: async () => ({ ok: !0 }),
        in_process: async () => ({ ok: !0 }),
        local_control: async () => ({ ok: !0 }),
      }),
        e.equal(t.describe().filter((e) => e.available).length, 5));
      const a = await t.dispatch("github_actions", { task: { id: "x" } });
      e.equal(a.output.authorization, "[redacted]");
    },
  ),
  a(
    "placement emits provider-independent #317 runtime and isolated workspace truth",
    () => {
      const t = y("runtime", {
          metadata: {
            endpoint_url: "https://secret.example",
            model_id: "vendor-model",
          },
        }),
        a = o({ workers: [t], adapters: v() }).place(w());
      (e.equal(a.runtime_profile.schema, "sideways-maker-runtime-profile/v1"),
        e.equal(a.runtime_profile.endpoint.capacity, "dedicated"),
        e.equal(a.workspace.ephemeral, !0));
      const s = JSON.stringify(a.runtime_profile);
      (e.ok(!s.includes("secret.example")),
        e.ok(!s.includes("vendor-model")),
        e.ok(!s.includes("node22")));
    },
  ),
  a(
    "registration updates preserve valid receipts across concurrency mutations",
    async () => {
      const t = o({ workers: [y("persist")], adapters: v() });
      t.submit(w());
      const a = await t.schedule();
      (e.equal(t.getWorker("persist").identity.trusted, !0),
        e.equal(t.getWorker("persist").health.evidence, "observed"),
        t.cancel("task-1", "stop"),
        e.equal(t.getWorker("persist").identity.trusted, !0),
        e.notEqual(a.lease.token, "[redacted]"));
    },
  ),
  a(
    "events and fleet snapshots are deterministic and secret-redacted",
    async () => {
      const t = f(),
        a = o({ workers: [y("det")], adapters: v(), clock: t.clock, id: t.id });
      (a.submit(w({ state: { token: "ghp_" + "x".repeat(30) } })),
        await a.schedule());
      const s = a.snapshot();
      (e.deepEqual(
        s.events.map((e) => e.sequence),
        [1, 2],
      ),
        e.match(s.snapshot_digest, /^[a-f0-9]{64}$/),
        e.ok(!JSON.stringify(s).includes("ghp_")));
    },
  ),
  a(
    "secret redaction is recursive without deleting token-count evidence",
    () => {
      const t = u({
        authorization: "Bearer abcdefghijklmnopqrstuvwxyz",
        input_tokens: 123,
        nested: { api_key: "sk-abcdefghijklmnop" },
      });
      (e.equal(t.authorization, "[redacted]"),
        e.equal(t.input_tokens, 123),
        e.equal(t.nested.api_key, "[redacted]"));
    },
  ),
  a("published schema covers all durable fleet receipt families", async () => {
    const a = JSON.parse(
        await t.readFile(
          new URL(
            "../../maker/contracts/worker-fleet.schema.json",
            import.meta.url,
          ),
          "utf8",
        ),
      ),
      s = new Set(a.oneOf.map((e) => e.$ref));
    for (const t of [
      "worker",
      "task",
      "attestation",
      "healthReceipt",
      "artifactReference",
      "placement",
      "runtimeProfile",
      "workspace",
      "lease",
      "dispatch",
      "execution",
      "usage",
      "event",
      "snapshot",
    ])
      e.ok(s.has(`#/$defs/${t}`), `missing ${t}`);
    (e.equal(
      a.$defs.placement.properties.runtime_profile.$ref,
      "#/$defs/runtimeProfile",
    ),
      e.equal(
        a.$defs.snapshot.properties.executions.items.$ref,
        "#/$defs/execution",
      ),
      e.equal(
        a.$defs.attestation.properties.schema.const,
        "sideways-maker-worker-attestation/v1",
      ));
  }));
