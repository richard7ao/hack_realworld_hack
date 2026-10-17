import { buildPath, endpoints, type EndpointName, type ResponseOf } from "./contract";

/**
 * Every network read goes through here, so a malformed response fails loudly at the boundary, next
 * to the schema that describes it, rather than as an undefined three components deep mid-demo.
 */
export async function fetchTyped<N extends EndpointName>(
  name: N,
  opts: { params?: Record<string, string>; query?: Record<string, string>; body?: unknown } = {},
): Promise<ResponseOf<N>> {
  const ep = endpoints[name];
  const qs = opts.query && Object.keys(opts.query).length ? `?${new URLSearchParams(opts.query)}` : "";
  const res = await fetch(`/api${buildPath(name, opts.params ?? {})}${qs}`, {
    method: ep.method,
    headers: { "content-type": "application/json" },
    body: ep.method === "GET" ? undefined : JSON.stringify(opts.body ?? {}),
    cache: "no-store",
  });
  const body: unknown = await res.json();
  if (!res.ok) {
    const detail = typeof body === "object" && body && "error" in body ? String(body.error) : JSON.stringify(body);
    throw new Error(detail);
  }
  return ep.response.parse(body) as ResponseOf<N>;
}

/** Readable text for anything thrown at the user. */
export const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
