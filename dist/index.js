import {
  DEFAULT_BASE_URL,
  DEFAULT_FALLBACK_ORDER,
  resolveApiKey,
  resolveWebSearchConfig,
  runHelveSearch,
} from "./helve-client.js";

const CREDENTIAL_PATH = "plugins.entries.helve-search.config.webSearch.apiKey";

const GENERIC_WEB_SEARCH_SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string", description: "Search query string." },
    count: {
      type: "integer",
      description: "Number of results to return (1-20).",
      minimum: 1,
      maximum: 20,
    },
    freshness: {
      type: "string",
      enum: ["day", "week", "month", "year"],
      description: "Optional recency filter.",
    },
  },
  required: ["query"],
  additionalProperties: false,
};

const HELVE_SEARCH_TOOL_SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string", description: "Search query string." },
    count: {
      type: "integer",
      description: "Number of results to return (1-20).",
      minimum: 1,
      maximum: 20,
    },
    provider: {
      type: "string",
      enum: ["brave", "tavily", "exa", "serper", "fusion", "auto", "parallel", "perplexity", "firecrawl"],
      description: "Optional explicit engine override. Omit to use ordered fallback (brave -> tavily -> exa -> serper).",
    },
    freshness: {
      type: "string",
      enum: ["day", "week", "month", "year"],
      description: "Optional recency window.",
    },
    category: {
      type: "string",
      enum: ["general", "news", "company", "people", "research"],
      description: "Optional content category.",
    },
    include_domains: {
      type: "array",
      items: { type: "string" },
      description: "Restrict results to these domains.",
    },
    exclude_domains: {
      type: "array",
      items: { type: "string" },
      description: "Exclude results from these domains.",
    },
  },
  required: ["query"],
  additionalProperties: false,
};

function toToolResult(data) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, 2),
      },
    ],
    details: data,
  };
}

export function createHelveWebSearchProvider() {
  return {
    id: "helve",
    label: "Helve Web Search",
    hint: "One HELVE_API_KEY with ordered fallback across Brave, Tavily, Exa, and Serper plus spend_limit_usd caps at 0% markup.",
    credentialLabel: "Helve API key",
    envVars: ["HELVE_API_KEY"],
    placeholder: "sk_live_...",
    signupUrl: "https://helve.dev/dashboard",
    docsUrl: "https://docs.helve.dev",
    credentialPath: CREDENTIAL_PATH,
    getCredentialValue: (searchConfig) => searchConfig?.helve?.apiKey ?? searchConfig?.apiKey,
    setCredentialValue: (searchConfigTarget, value) => {
      const target = (searchConfigTarget.helve ??= {});
      target.apiKey = value;
    },
    createTool: (ctx = {}) => ({
      description:
        "Search the web via Helve with ordered fallback across Brave, Tavily, Exa, and Serper through one HELVE_API_KEY and per-key spend_limit_usd caps.",
      parameters: GENERIC_WEB_SEARCH_SCHEMA,
      execute: async (args, executionContext) => {
        executionContext?.signal?.throwIfAborted?.();
        const cfg = ctx?.config ?? {};
        const wsCfg = resolveWebSearchConfig(cfg);
        const searchCfg = ctx?.searchConfig ?? {};
        const data = await runHelveSearch({
          query: typeof args?.query === "string" ? args.query : "",
          count: args?.count ?? searchCfg?.maxResults ?? 10,
          freshness: args?.freshness,
          fallbackOrder: wsCfg.fallbackOrder ?? DEFAULT_FALLBACK_ORDER,
          baseUrl: wsCfg.baseUrl ?? DEFAULT_BASE_URL,
          apiKey: resolveApiKey(cfg) || searchCfg?.helve?.apiKey || searchCfg?.apiKey,
          spendLimitUsd: wsCfg.spendLimitUsd,
          timeoutSeconds: searchCfg?.timeoutSeconds ?? 20,
          signal: executionContext?.signal,
        });
        return toToolResult(data);
      },
    }),
  };
}

const plugin = {
  id: "helve-search",
  name: "Helve Web Search",
  description:
    "OpenClaw web search provider plugin backed by Helve — one HELVE_API_KEY with ordered fallback across Brave, Tavily, Exa, and Serper plus spend_limit_usd caps.",
  register(api) {
    api.registerWebSearchProvider(createHelveWebSearchProvider());
    api.registerTool({
      name: "helve_search",
      label: "Helve Search",
      description:
        "Search the web through Helve with ordered fallback (Brave -> Tavily -> Exa -> Serper), fusion consensus mode, domain filters, and per-key spend_limit_usd caps.",
      parameters: HELVE_SEARCH_TOOL_SCHEMA,
      execute: async (_toolCallId, rawParams, signal) => {
        signal?.throwIfAborted?.();
        const cfg = api?.config ?? {};
        const wsCfg = resolveWebSearchConfig(cfg);
        const data = await runHelveSearch({
          query: typeof rawParams?.query === "string" ? rawParams.query : "",
          count: rawParams?.count ?? 10,
          provider: rawParams?.provider,
          freshness: rawParams?.freshness,
          category: rawParams?.category,
          includeDomains: rawParams?.include_domains,
          excludeDomains: rawParams?.exclude_domains,
          fallbackOrder: wsCfg.fallbackOrder ?? DEFAULT_FALLBACK_ORDER,
          baseUrl: wsCfg.baseUrl ?? DEFAULT_BASE_URL,
          apiKey: resolveApiKey(cfg),
          spendLimitUsd: wsCfg.spendLimitUsd,
          signal,
        });
        return toToolResult(data);
      },
    });
  },
};

export default plugin;
