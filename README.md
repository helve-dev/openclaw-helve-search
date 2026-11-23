# Helve Web Search for OpenClaw

Native OpenClaw `web_search` provider plugin backed by [Helve](https://helve.dev).

Use one `HELVE_API_KEY` instead of juggling separate Brave, Tavily, Exa, and Serper accounts. When an engine returns `429`, a quota error, or an upstream error, the plugin automatically falls back down the ordered chain (`brave -> tavily -> exa -> serper`) and enforces deterministic per-key `spend_limit_usd` caps at **0% markup** (`$1` free credit ≈ 1,000 Serper searches).

## Install

```bash
openclaw plugins install npm:@helve-dev/openclaw-helve-search
```

## Configure

Set your Helve API key in OpenClaw config or via environment variable:

```bash
export HELVE_API_KEY="sk_live_..."
```

Or in `openclaw.json`:

```json5
{
  plugins: {
    entries: {
      "helve-search": {
        config: {
          webSearch: {
            apiKey: "sk_live_...",
            fallbackOrder: ["brave", "tavily", "exa", "serper"],
            spendLimitUsd: 1.0
          }
        }
      }
    }
  }
}
```

## Ordered Fallback Behavior

1. Default chain: **`brave` -> `tavily` -> `exa` -> `serper`**.
2. On HTTP `429`, quota/rate-limit errors, expired upstream keys, or `5xx` responses, the plugin moves to the next engine automatically and records `fallback_attempts` in the tool details.
3. On HTTP `402` (`spend_limit_exceeded`) or invalid `HELVE_API_KEY` (`401`), the plugin stops immediately with an actionable message pointing to `https://helve.dev/dashboard`.
4. Failed upstream calls are escrowed at `$0.00` by Helve.

## Tools Registered

- **Native `web_search` provider (`id: "helve"`):** Plugs directly into OpenClaw's built-in `web_search` tool with normalized `{ title, url, snippet }` results.
- **`helve_search`:** Explicit tool supporting `provider` overrides (including `fusion` consensus search), `freshness`, `category`, `include_domains`, and `exclude_domains`.

## Links

- Dashboard & API keys (`$1` free starter credit, 0% markup): https://helve.dev/dashboard
- Documentation (330+ APIs across 260+ providers): https://docs.helve.dev
- Source: https://github.com/helve-dev/openclaw-helve-search
