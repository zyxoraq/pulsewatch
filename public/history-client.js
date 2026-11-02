/** Keeps the latest monitor/filter request authoritative even if an older request ignores abort. */
export function createHistoryClient({ fetchImpl = fetch, onState }) {
  let version = 0, controller;
  function cancel() {
    version++;
    controller?.abort();
    controller = null;
  }
  async function load(id, filter) {
    cancel();
    const requestVersion = version;
    controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]);
    onState({ status: 'loading', id, filter });
    try {
      const query = new URLSearchParams({ filter, limit: '500' });
      const response = await fetchImpl(`/api/monitors/${encodeURIComponent(id)}/history?${query}`, { signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `History request failed (${response.status})`);
      if (version === requestVersion) onState({ status: 'ready', id, filter, data });
    } catch (error) {
      if (version === requestVersion) onState({ status: 'error', id, filter, error: error.name === 'TimeoutError' ? 'History request timed out. Try refreshing.' : error.message });
    }
  }
  return { load, cancel };
}
