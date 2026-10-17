import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Keep local webcam traffic same-origin; provider credentials never enter this proxy. */
async function forward(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  if (!path.length || path.some((part) => !/^[a-zA-Z0-9_.-]+$/.test(part) || part === "..")) {
    return Response.json({ error: "Invalid FAULTLINE API path" }, { status: 400 });
  }
  const backend = process.env.FAULTLINE_API_URL ?? "http://127.0.0.1:8787";
  const url = new URL(`/api/${path.map(encodeURIComponent).join("/")}${request.nextUrl.search}`, backend);
  const headers = new Headers();
  for (const key of ["authorization", "content-type"]) {
    const value = request.headers.get(key);
    if (value) headers.set(key, value);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const body = request.method === "GET" ? undefined : await request.arrayBuffer();
    if (body && body.byteLength > 1_600_000) return Response.json({ error: "Request exceeds 1.6 MB" }, { status: 413 });
    const response = await fetch(url, { method: request.method, headers, body, signal: controller.signal, cache: "no-store" });
    const responseHeaders = new Headers({ "Cache-Control": "no-store" });
    for (const key of ["content-type", "content-disposition"]) {
      const value = response.headers.get(key);
      if (value) responseHeaders.set(key, value);
    }
    return new Response(response.body, { status: response.status, headers: responseHeaders });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "AbortError";
    return Response.json({ error: timedOut ? "Local backend timed out. Check its terminal." : "Local backend is unavailable. Start backend.app on port 8787." }, { status: timedOut ? 504 : 503 });
  } finally { clearTimeout(timeout); }
}
export const GET = forward;
export const POST = forward;
