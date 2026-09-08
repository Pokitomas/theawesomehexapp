import { timingSafeEqual } from "node:crypto";
import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { callMach } from "../../../../../lib/bus";

export const runtime = "nodejs";
export const maxDuration = 120;
export const dynamic = "force-dynamic";

function sameSecret(a: string, b: string) {
  const aa = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return aa.length === bb.length && aa.length > 20 && timingSafeEqual(aa, bb);
}

function toolResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  };
}

function makeHandler() {
  return createMcpHandler(
    (server) => {
      server.registerTool(
        "pc_status",
        {
          title: "PC Status",
          description: "Use this first when you need the live state of Kai's authorized Windows PC and Mach runtime. Returns host/user/runtime identity and key Mach GUI claims.",
          inputSchema: z.object({}),
          annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        },
        async () => toolResult(await callMach({ op: "status" }, 30000)),
      );

      server.registerTool(
        "pc_telemetry",
        {
          title: "PC Telemetry",
          description: "Use this when you need current GPU, RAM, and top-process telemetry from the authorized PC.",
          inputSchema: z.object({}),
          annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        },
        async () => toolResult(await callMach({ op: "telemetry" }, 30000)),
      );

      server.registerTool(
        "mach_ask",
        {
          title: "Read Mach Claims",
          description: "Use this to read live claims from the running Mach world. Prefer this over guessing runtime state.",
          inputSchema: z.object({
            claims: z.array(z.string().min(1).max(500)).min(1).max(64),
            wait_s: z.number().int().min(1).max(30).optional(),
          }),
          annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        },
        async ({ claims, wait_s }) => toolResult(await callMach({ op: "mach", ask: claims, wait_s: wait_s ?? 10 }, 45000)),
      );

      server.registerTool(
        "mach_do",
        {
          title: "Act Through Mach",
          description: "Use this to perform an intentional live Mach expression, optionally reading claims immediately afterward. This changes live machine state.",
          inputSchema: z.object({
            expr: z.string().min(1).max(20000),
            ask: z.array(z.string().min(1).max(500)).max(64).optional(),
            wait_s: z.number().int().min(1).max(30).optional(),
          }),
          annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
        },
        async ({ expr, ask, wait_s }) => toolResult(await callMach({ op: "mach", expr, ask: ask ?? [], wait_s: wait_s ?? 15 }, 50000)),
      );

      server.registerTool(
        "mach_list",
        {
          title: "List Mach Files",
          description: "Use this to list files or directories inside C:\\Users\\AwesomeKai\\mach. Paths cannot escape the Mach root.",
          inputSchema: z.object({ path: z.string().default(".") }),
          annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        },
        async ({ path }) => toolResult(await callMach({ op: "list", path }, 30000)),
      );

      server.registerTool(
        "mach_read",
        {
          title: "Read Mach File",
          description: "Use this to read a current file from the local Mach source tree before editing or reasoning about it. Paths cannot escape the Mach root.",
          inputSchema: z.object({
            path: z.string().min(1),
            max_bytes: z.number().int().min(1).max(1000000).optional(),
          }),
          annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        },
        async ({ path, max_bytes }) => toolResult(await callMach({ op: "read", path, max_bytes: max_bytes ?? 300000 }, 30000)),
      );

      server.registerTool(
        "mach_write",
        {
          title: "Write Mach File",
          description: "Use this to atomically replace a UTF-8 file inside the Mach source tree. Supply expected_sha256 when editing an observed file so concurrent changes cannot be overwritten silently.",
          inputSchema: z.object({
            path: z.string().min(1),
            content: z.string(),
            expected_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
          }),
          annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: true },
        },
        async ({ path, content, expected_sha256 }) => toolResult(await callMach({ op: "write", path, content, expected_sha256 }, 45000)),
      );

      server.registerTool(
        "mach_python",
        {
          title: "Run Python In Mach",
          description: "Use this for local Mach development, tests, inspection, or automation that needs Python on the authorized PC. The working directory must remain under the Mach root.",
          inputSchema: z.object({
            args: z.array(z.string()).min(1).max(128),
            cwd: z.string().optional(),
            timeout_s: z.number().int().min(1).max(300).optional(),
          }),
          annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false },
        },
        async ({ args, cwd, timeout_s }) => toolResult(await callMach({ op: "python", args, cwd, timeout_s: timeout_s ?? 120 }, Math.min((timeout_s ?? 120) * 1000 + 15000, 115000))),
      );

      server.registerTool(
        "pc_computer",
        {
          title: "Operate PC Through Mach",
          description: "Use this to operate or observe the authorized Windows desktop through Mach's existing computer interface. Pass the same request object Mach's say.py --computer accepts, such as capture, click, key, or typing operations.",
          inputSchema: z.object({
            request: z.record(z.string(), z.unknown()),
            timeout_s: z.number().int().min(1).max(120).optional(),
          }),
          annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false },
        },
        async ({ request, timeout_s }) => toolResult(await callMach({ op: "computer", request, timeout_s: timeout_s ?? 60 }, Math.min((timeout_s ?? 60) * 1000 + 15000, 115000))),
      );
    },
    {
      serverInfo: { name: "Mach", version: "0.1.0" },
      instructions: "This server is the live tool surface for Kai's authorized PC and Mach runtime. Prefer observing current state before mutation. Use Mach-native claims and computer operations rather than inventing state. File operations are rooted to the Mach source tree.",
    },
  );
}

type Ctx = { params: Promise<{ key: string }> };

async function route(req: Request, ctx: Ctx) {
  const { key } = await ctx.params;
  const expected = process.env.MACH_CONNECTOR_KEY ?? "";
  if (!sameSecret(key, expected)) return new Response("Not Found", { status: 404 });
  return makeHandler()(req);
}

export { route as GET, route as POST, route as DELETE };
