import test from "node:test";
import assert from "node:assert/strict";
import plugin, { createHelveWebSearchProvider } from "../dist/index.js";
import { runHelveSearch, resetSessionSpend } from "../dist/helve-client.js";

test("runHelveSearch normalizes results and tracks cost on primary provider", async () => {
  resetSessionSpend();
  const seen = [];
  const fakeFetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    seen.push(body.provider);
    return new Response(
      JSON.stringify({
        id: "srch_1",
        provider: "brave",
        latency_ms: 142,
        usage: { cost_usd: 0.005, credits: 5 },
        warnings: [],
        results: [
          { id: "r1", url: "https://docs.openclaw.ai", title: "OpenClaw Docs", snippets: ["Build plugins"] },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  const out = await runHelveSearch({
    query: "openclaw plugin sdk",
    count: 5,
    apiKey: "sk_live_test",
    fetchImpl: fakeFetch,
  });

  assert.deepEqual(seen, ["brave"]);
  assert.equal(out.provider, "brave");
  assert.equal(out.cost_usd, 0.005);
  assert.deepEqual(out.results, [
    { title: "OpenClaw Docs", url: "https://docs.openclaw.ai", snippet: "Build plugins" },
  ]);
});

test("runHelveSearch falls back brave -> tavily -> exa -> serper on 429/quota/503", async () => {
  resetSessionSpend();
  const seen = [];
  const fakeFetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    seen.push(body.provider);
    if (body.provider === "brave") {
      return new Response(JSON.stringify({ error: { type: "rate_limit", message: "429 Too Many Requests" } }), { status: 429 });
    }
    if (body.provider === "tavily") {
      return new Response(JSON.stringify({ error: { type: "quota_exceeded", message: "quota reached" } }), { status: 400 });
    }
    if (body.provider === "exa") {
      return new Response(JSON.stringify({ error: { type: "upstream_error", message: "503 unavailable" } }), { status: 503 });
    }
    return new Response(
      JSON.stringify({
        id: "srch_4",
        provider: "serper",
        latency_ms: 95,
        usage: { cost_usd: 0.001, credits: 1 },
        warnings: [],
        results: [{ id: "r1", url: "https://helve.dev", title: "Helve", snippets: ["0% markup gateway"] }],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  const out = await runHelveSearch({
    query: "helve gateway",
    apiKey: "sk_live_test",
    fetchImpl: fakeFetch,
  });

  assert.deepEqual(seen, ["brave", "tavily", "exa", "serper"]);
  assert.equal(out.provider, "serper");
  assert.equal(out.fallback_attempts.length, 3);
  assert.equal(out.results[0].url, "https://helve.dev");
});

test("runHelveSearch stops immediately on 402 spend_limit_exceeded", async () => {
  resetSessionSpend();
  const seen = [];
  const fakeFetch = async (_url, init) => {
    seen.push(JSON.parse(init.body).provider);
    return new Response(
      JSON.stringify({ error: { type: "spend_limit_exceeded", message: "Key spend limit reached" } }),
      { status: 402 }
    );
  };

  await assert.rejects(
    () => runHelveSearch({ query: "test", apiKey: "sk_live_test", fetchImpl: fakeFetch }),
    /spend limit reached/i
  );
  assert.deepEqual(seen, ["brave"]);
});

test("runHelveSearch enforces local spendLimitUsd cap", async () => {
  resetSessionSpend();
  const fakeFetch = async () =>
    new Response(
      JSON.stringify({
        id: "srch_cap",
        provider: "brave",
        latency_ms: 50,
        usage: { cost_usd: 0.01, credits: 10 },
        warnings: [],
        results: [],
      }),
      { status: 200 }
    );

  await runHelveSearch({ query: "first", apiKey: "sk_live_test", spendLimitUsd: 0.01, fetchImpl: fakeFetch });
  await assert.rejects(
    () => runHelveSearch({ query: "second", apiKey: "sk_live_test", spendLimitUsd: 0.01, fetchImpl: fakeFetch }),
    /spendLimitUsd cap/i
  );
});

test("plugin registers webSearchProvider and helve_search tool with required contract fields", () => {
  const providers = [];
  const tools = [];
  plugin.register({
    config: {},
    registerWebSearchProvider: (p) => providers.push(p),
    registerTool: (t) => tools.push(t),
  });

  assert.equal(providers.length, 1);
  assert.equal(providers[0].id, "helve");
  for (const field of ["hint", "envVars", "placeholder", "signupUrl", "credentialPath", "getCredentialValue", "setCredentialValue", "createTool"]) {
    assert.ok(providers[0][field], `missing required field ${field}`);
  }
  const target = {};
  providers[0].setCredentialValue(target, "sk_live_abc");
  assert.equal(providers[0].getCredentialValue(target), "sk_live_abc");
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "helve_search");
});
