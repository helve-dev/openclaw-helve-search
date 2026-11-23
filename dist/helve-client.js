export const DEFAULT_BASE_URL = "https://helve.dev";
export const DEFAULT_FALLBACK_ORDER = ["brave", "tavily", "exa", "serper"];

const RETRYABLE_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);
const RETRYABLE_ERROR_PATTERNS = [
  /429/i,
  /rate[\s_-]?limit/i,
  /quota/i,
  /exhausted/i,
  /upstream/i,
  /expired/i,
  /provider[\s_-]?(error|unavailable|timeout)/i,
  /temporarily unavailable/i,
];

let sessionSpendUsd = 0;

export function resetSessionSpend() {
  sessionSpendUsd = 0;
}

export function getSessionSpendUsd() {
  return sessionSpendUsd;
}

export function resolveApiKey(config) {
  const configured =
    config?.plugins?.entries?.["helve-search"]?.config?.webSearch?.apiKey ??
    config?.webSearch?.apiKey ??
    config?.helve?.apiKey;
  if (typeof configured === "string" && configured.trim()) {
    return configured.trim();
  }
  return (process.env.HELVE_API_KEY || "").trim();
}

export function resolveWebSearchConfig(config) {
  return (
    config?.plugins?.entries?.["helve-search"]?.config?.webSearch ??
    config?.webSearch ??
    {}
  );
}

function isSpendLimitError(status, payload, text) {
  const errType = String(payload?.error?.type || payload?.error?.code || "");
  const errMsg = String(payload?.error?.message || text || "");
  if (status === 402) return true;
  return /spend_limit|insufficient_balance|budget/i.test(`${errType} ${errMsg}`);
}

function isHelveAuthError(status, payload, text) {
  if (status !== 401) return false;
  const errType = String(payload?.error?.type || payload?.error?.code || "");
  const errMsg = String(payload?.error?.message || text || "");
  if (/upstream|provider/i.test(`${errType} ${errMsg}`)) {
    return false;
  }
  return true;
}

function shouldFallback(status, payload, text) {
  if (RETRYABLE_HTTP_STATUSES.has(status)) return true;
  const combined = `${payload?.error?.type || ""} ${payload?.error?.code || ""} ${payload?.error?.message || ""} ${text || ""}`;
  return RETRYABLE_ERROR_PATTERNS.some((re) => re.test(combined));
}

export function normalizeResults(payload, maxResults) {
  const rawList = Array.isArray(payload?.results) ? payload.results : [];
  const items = [];
  for (const r of rawList) {
    if (!r || typeof r !== "object") continue;
    const url = r.url || r.href || r.link || "";
    if (!url) continue;
    const snippets = Array.isArray(r.snippets)
      ? r.snippets.filter((s) => typeof s === "string" && s.trim()).join("\n")
      : "";
    const snippet =
      snippets ||
      r.summary ||
      r.content ||
      r.snippet ||
      r.full_text ||
      "";
    items.push({
      title: typeof r.title === "string" && r.title.trim() ? r.title.trim() : url,
      url,
      snippet,
      ...(r.published_date ? { published_date: r.published_date } : {}),
      ...(typeof r.score === "number" ? { score: r.score } : {}),
    });
    if (maxResults && items.length >= maxResults) break;
  }
  return items;
}

export async function runHelveSearch({
  query,
  count = 10,
  provider,
  freshness,
  category,
  includeDomains,
  excludeDomains,
  fallbackOrder,
  baseUrl,
  apiKey,
  spendLimitUsd,
  timeoutSeconds = 20,
  signal,
  fetchImpl = fetch,
}) {
  if (!query || typeof query !== "string" || !query.trim()) {
    throw new Error("query is required.");
  }

  const key = (apiKey || process.env.HELVE_API_KEY || "").trim();
  if (!key) {
    throw new Error(
      "Missing HELVE_API_KEY. Set plugins.entries.helve-search.config.webSearch.apiKey or HELVE_API_KEY ($1 free credit at https://helve.dev/dashboard)."
    );
  }

  if (typeof spendLimitUsd === "number" && spendLimitUsd >= 0 && sessionSpendUsd >= spendLimitUsd) {
    throw new Error(
      `Local session spendLimitUsd cap ($${spendLimitUsd.toFixed(4)}) reached (spent $${sessionSpendUsd.toFixed(4)}).`
    );
  }

  const endpoint = `${(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "")}/v1/search`;
  const maxResults = Math.min(Math.max(1, Number(count) || 10), 100);
  const chain = provider
    ? [provider]
    : Array.isArray(fallbackOrder) && fallbackOrder.length > 0
      ? fallbackOrder
      : DEFAULT_FALLBACK_ORDER;

  const attempts = [];

  for (let i = 0; i < chain.length; i++) {
    signal?.throwIfAborted?.();
    const candidate = chain[i];
    const body = {
      query: query.trim(),
      provider: candidate,
      max_results: maxResults,
    };
    if (freshness) body.freshness = freshness;
    if (category) body.category = category;
    if (Array.isArray(includeDomains) && includeDomains.length > 0) {
      body.include_domains = includeDomains;
    }
    if (Array.isArray(excludeDomains) && excludeDomains.length > 0) {
      body.exclude_domains = excludeDomains;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`Helve search timeout (${timeoutSeconds}s)`)), timeoutSeconds * 1000);
    const onAbort = () => controller.abort(signal.reason);
    signal?.addEventListener?.("abort", onAbort, { once: true });

    let res;
    let text = "";
    let payload = null;
    try {
      res = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
          "User-Agent": "openclaw-helve-search/0.1.0",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      text = await res.text();
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = null;
      }
    } catch (err) {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      if (signal?.aborted) throw err;
      attempts.push({ provider: candidate, status: 0, error: err?.message || String(err) });
      if (i < chain.length - 1) continue;
      throw new Error(`Helve search failed across [${chain.join(" -> ")}]: ${err?.message || err}`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
    }

    if (res.ok && payload) {
      const costUsd = typeof payload?.usage?.cost_usd === "number" ? payload.usage.cost_usd : 0;
      sessionSpendUsd += costUsd;
      const results = normalizeResults(payload, maxResults);
      return {
        query: query.trim(),
        provider: payload.provider || candidate,
        results,
        cost_usd: costUsd,
        session_spend_usd: Number(sessionSpendUsd.toFixed(6)),
        latency_ms: payload.latency_ms ?? null,
        fallback_attempts: attempts,
        warnings: Array.isArray(payload.warnings) ? payload.warnings : [],
      };
    }

    if (isSpendLimitError(res.status, payload, text)) {
      const msg = payload?.error?.message || text || "spend_limit_exceeded";
      throw new Error(`Helve spend limit reached (HTTP ${res.status}): ${msg}. Manage caps at https://helve.dev/dashboard.`);
    }

    if (isHelveAuthError(res.status, payload, text)) {
      throw new Error(
        `Helve authentication failed (HTTP 401). Check your HELVE_API_KEY at https://helve.dev/dashboard.`
      );
    }

    const errMsg = payload?.error?.message || text.slice(0, 200) || `HTTP ${res.status}`;
    attempts.push({ provider: candidate, status: res.status, error: errMsg });

    if (shouldFallback(res.status, payload, text) && i < chain.length - 1) {
      continue;
    }

    throw new Error(`Helve search error on ${candidate} (HTTP ${res.status}): ${errMsg}`);
  }

  throw new Error(`Helve search exhausted fallback order [${chain.join(" -> ")}].`);
}
