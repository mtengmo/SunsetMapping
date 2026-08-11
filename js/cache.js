// Thin localStorage cache for third-party API responses (Overpass,
// elevation). Helps only within a single browser across repeat visits/pans
// to the same area — there's no shared backend, so it can't help across
// different users or first-time unique queries.
const LocalCache = (() => {
  const PREFIX = "sunsetSim:";

  function hashKey(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  function get(rawKey) {
    try {
      const raw = localStorage.getItem(PREFIX + hashKey(rawKey));
      if (!raw) return null;
      const { t, ttl, data } = JSON.parse(raw);
      if (Date.now() - t > ttl) {
        localStorage.removeItem(PREFIX + hashKey(rawKey));
        return null;
      }
      return data;
    } catch {
      return null; // storage unavailable (private browsing, disabled, etc.) — just skip caching
    }
  }

  function set(rawKey, data, ttlMs) {
    const entry = JSON.stringify({ t: Date.now(), ttl: ttlMs, data });
    try {
      localStorage.setItem(PREFIX + hashKey(rawKey), entry);
    } catch {
      // Likely quota exceeded — clear our own entries once and retry, then give up quietly.
      try {
        clearAll();
        localStorage.setItem(PREFIX + hashKey(rawKey), entry);
      } catch {
        /* caching is a nice-to-have; failing silently is fine */
      }
    }
  }

  function clearAll() {
    try {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(PREFIX)) keys.push(k);
      }
      keys.forEach((k) => localStorage.removeItem(k));
    } catch {
      /* no-op */
    }
  }

  return { get, set, clearAll };
})();
