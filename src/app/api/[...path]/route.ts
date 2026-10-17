import { NextRequest, NextResponse } from "next/server";
import { CreateRunRequest, endpoints, type EndpointName } from "../../../lib/contract";
import { createRun, getRun, readFixture, UnknownEnvironment } from "../../../lib/server/store";

/**
 * The single seam between the two halves of the app.
 *
 * Components always fetch /api/<path>. This route decides where the bytes come from: the fixture
 * engine, or your teammate's Modal deployment. Because the decision lives here and not in component
 * code, the frontend is never blocked on the backend, and going live is an env var, not a refactor.
 *
 *   DATA_MODE=fixture   (default) everything is generated and served locally
 *   DATA_MODE=live      proxied to API_URL, e.g. https://<org>--forkbench-api.modal.run
 */
const json = (body: unknown, status = 200) => NextResponse.json(body, { status });

/** Match a concrete request against the contract's `:param` patterns. */
function match(method: string, segments: string[]) {
  for (const [name, ep] of Object.entries(endpoints) as [EndpointName, (typeof endpoints)[EndpointName]][]) {
    if (ep.method !== method) continue;
    const pattern = ep.path.replace(/^\//, "").split("/");
    if (pattern.length !== segments.length) continue;
    const params: Record<string, string> = {};
    const ok = pattern.every((p, i) => {
      const seg = segments[i]!;
      if (p.startsWith(":")) { params[p.slice(1)] = seg; return true; }
      return p === seg;
    });
    if (ok) return { name, params };
  }
  return null;
}

async function live(req: NextRequest, path: string[], search: string) {
  const base = (process.env.API_URL ?? "http://localhost:8787").replace(/\/$/, "");
  // Attached here, on the server, so the shared token is never shipped to the browser.
  const token = process.env.API_TOKEN;
  try {
    const res = await fetch(`${base}/${path.join("/")}${search}`, {
      method: req.method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: req.method === "GET" ? undefined : await req.text(),
      cache: "no-store",
    });
    return new NextResponse(await res.text(), { status: res.status, headers: { "content-type": "application/json" } });
  } catch (err) {
    // A dead backend must say so plainly rather than surfacing as a parse error three components
    // deep. The detail stays on the server though: API_URL is an internal deployment address and
    // the client has no use for it.
    console.error(`[forkbench] backend unreachable at ${base}:`, err);
    return json({ error: "The evaluation backend is unavailable. Check API_URL, or unset DATA_MODE to use fixtures." }, 502);
  }
}

async function handle(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  if ((process.env.DATA_MODE ?? "fixture") === "live") return live(req, path, req.nextUrl.search);

  const hit = match(req.method, path);
  if (!hit) return json({ error: `no contract endpoint for ${req.method} /${path.join("/")}` }, 404);

  try {
    if (hit.name === "environments") return json(readFixture("environments"));
    if (hit.name === "run") return json(getRun(hit.params.id!));
    if (hit.name === "createRun") {
      const parsed = CreateRunRequest.safeParse(await req.json());
      if (!parsed.success) return json({ ok: false, runId: null, error: parsed.error.issues[0]?.message ?? "Invalid request." });
      try {
        return json({ ok: true, runId: createRun(parsed.data).id, error: null });
      } catch (err) {
        if (err instanceof UnknownEnvironment) return json({ ok: false, runId: null, error: err.message });
        throw err;
      }
    }
    return json({ error: `unhandled endpoint ${hit.name}` }, 500);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}

export const GET = handle;
export const POST = handle;
