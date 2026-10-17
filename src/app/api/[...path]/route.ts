import { NextRequest, NextResponse } from "next/server";
import { endpoints, GateRequest, RerunRequest, RunBenchmarkRequest, type EndpointName } from "../../../lib/contract";
import { gate, getBenchmark, getCaseDetail, listBenchmarks, NotFound, rerun, runBenchmark, scenario } from "../../../lib/server/store";

/**
 * The single seam between the two halves of the app.
 *
 * Components always fetch /api/<path>. This route decides where the bytes come from: the demo
 * fixture engine, or the teammates' FAULTLINE backend. Going live is an env var, not a refactor.
 *
 *   DATA_MODE=fixture   (default) deterministic demo data, labelled demo_fixture in the UI
 *   DATA_MODE=live      forwarded verbatim to ${API_URL}/api/<path>, with the bearer token attached
 */
const json = (body: unknown, status = 200) => NextResponse.json(body, { status });

function match(method: string, segments: string[]) {
  for (const [name, ep] of Object.entries(endpoints) as [EndpointName, (typeof endpoints)[EndpointName]][]) {
    if (ep.method !== method) continue;
    const pattern = ep.path.replace(/^\//, "").split("/");
    if (pattern.length !== segments.length) continue;
    const params: Record<string, string> = {};
    const ok = pattern.every((p, i) => {
      const seg = segments[i]!;
      if (p.startsWith(":")) { params[p.slice(1)] = decodeURIComponent(seg); return true; }
      return p === seg;
    });
    if (ok) return { name, params };
  }
  return null;
}

async function live(req: NextRequest, path: string[], search: string) {
  const base = (process.env.API_URL ?? "http://localhost:8000").replace(/\/$/, "");
  const token = process.env.API_TOKEN;
  try {
    const res = await fetch(`${base}/api/${path.join("/")}${search}`, {
      method: req.method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: req.method === "GET" ? undefined : await req.text(),
      cache: "no-store",
    });
    return new NextResponse(await res.text(), { status: res.status, headers: { "content-type": "application/json" } });
  } catch (err) {
    // The internal address stays in the server log; the client only learns the backend is down.
    console.error(`[faultline] backend unreachable at ${base}:`, err);
    return json({ error: "The FAULTLINE backend is unavailable. Check API_URL, or unset DATA_MODE to use demo data." }, 502);
  }
}

async function handle(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  if ((process.env.DATA_MODE ?? "fixture") === "live") return live(req, path, req.nextUrl.search);

  const hit = match(req.method, path);
  if (!hit) return json({ error: `No endpoint for ${req.method} /api/${path.join("/")}` }, 404);
  const p = hit.params;
  const body = async <T,>(schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: { issues: { message: string }[] } } }) => {
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new BadRequest(parsed.error.issues[0]?.message ?? "Invalid request body.");
    return parsed.data;
  };

  try {
    switch (hit.name) {
      case "benchmarkList": return json(listBenchmarks());
      case "benchmark": return json(getBenchmark(p.run_id!));
      case "caseDetail": return json(getCaseDetail(p.run_id!, p.case_id!));
      case "scenario": return json(scenario(p.case_id!));
      case "runBenchmark": return json(runBenchmark((await body(RunBenchmarkRequest)).policy_id));
      case "rerun": return json(rerun(p.case_id!, (await body(RerunRequest)).policy_id));
      case "gate": { const g = await body(GateRequest); return json(gate(g.baseline_run_id, g.candidate_run_id)); }
    }
  } catch (err) {
    if (err instanceof NotFound) return json({ error: err.message }, 404);
    if (err instanceof BadRequest) return json({ error: err.message }, 400);
    console.error("[faultline] fixture handler failed:", err);
    return json({ error: "The demo backend hit an internal error." }, 500);
  }
}

class BadRequest extends Error {}

export const GET = handle;
export const POST = handle;
