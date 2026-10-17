"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchTyped } from "./client";
import type { EndpointName, ResponseOf } from "./contract";

/**
 * Deliberately not react-query: one hook, no cache layer, no extra dependency to explain.
 * `pollMs` keeps a live run current; it is ignored once `until` says the run has finished, so a
 * completed run stops hitting the network.
 */
export function useEndpoint<N extends EndpointName>(
  name: N,
  opts: { params?: Record<string, string>; query?: Record<string, string>; pollMs?: number; until?: (data: ResponseOf<N>) => boolean } = {},
) {
  const key = JSON.stringify({ params: opts.params, query: opts.query });
  const { pollMs, until } = opts;
  const [data, setData] = useState<ResponseOf<N> | null>(null);
  const [error, setError] = useState<unknown>(null);

  // Each request takes a ticket; only the newest one, on a still-mounted component, may write.
  const ticket = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const load = useCallback(async (): Promise<ResponseOf<N> | null> => {
    const mine = ++ticket.current;
    const current = () => mounted.current && mine === ticket.current;
    try {
      const next = await fetchTyped(name, JSON.parse(key) as { params?: Record<string, string> });
      if (!current()) return null;
      setData(next);
      setError(null);
      return next;
    } catch (err) {
      if (current()) setError(err);
      return null;
    }
  }, [name, key]);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const next = await load();
      if (!live || !pollMs) return;
      if (next && until?.(next)) return;
      timer = setTimeout(tick, pollMs);
    };
    void tick();
    return () => { live = false; clearTimeout(timer); };
    // `until` is a predicate recreated each render; polling must not restart because of it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, pollMs]);

  return { data, error, loading: !data && !error, reload: load };
}
