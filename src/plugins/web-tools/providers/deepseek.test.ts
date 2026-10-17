// FILE: src/plugins/web-tools/providers/deepseek.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify direct DeepSeek Search and Fetch endpoint routing, request mapping, operator pass-through, freshness mapping, need_content semantics, normalization, bounded 429 retry, balance and other error mapping, and credential safety.
//   SCOPE: Deterministic injected-fetch coverage with no live provider calls and no real credentials.
//   DEPENDS: [bun:test, src/plugins/web-tools/providers/deepseek.ts]
//   LINKS: [M-WEB-DEEPSEEK, V-M-WEB-DEEPSEEK]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   CREDENTIAL - Synthetic DeepSeek credential fixture.
//   searchInput - Build a provider-neutral search input.
//   fetchInput - Build a fetch input.
//   jsonResponse - Build a JSON response fixture.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [direct change - Added deterministic direct DeepSeek provider coverage.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import type { FetchLike } from "../http.js";
import type { WebSearchInput } from "./exa.js";
import { fetchDeepseek, searchDeepseek } from "./deepseek.js";

const CREDENTIAL = { value: "deepseek-secret", source: "env" as const };

function searchInput(overrides: Partial<WebSearchInput> = {}): WebSearchInput {
  return {
    query: "deepseek search api",
    count: 8,
    credential: CREDENTIAL,
    abort: new AbortController().signal,
    timeoutMs: 1000,
    ...overrides,
  };
}

function fetchInput(overrides: Partial<{ url: string; timeoutMs: number }> = {}) {
  return {
    url: "https://example.test/page",
    credential: CREDENTIAL,
    abort: new AbortController().signal,
    timeoutMs: 12000,
    ...overrides,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("searchDeepseek", () => {
  test("routes search to the documented endpoint with bearer auth and need_content false", async () => {
    let requestedUrl = "";
    let requestedHeaders: Record<string, string> | undefined;
    let requestedBody: Record<string, unknown> = {};
    const fetchImpl: FetchLike = async (url, init) => {
      requestedUrl = String(url);
      requestedHeaders = init?.headers as Record<string, string>;
      requestedBody = JSON.parse(String(init?.body));
      return jsonResponse({ results: [] });
    };

    const results = await searchDeepseek(searchInput({ freshness: undefined }), fetchImpl, {
      retryBackoffMs: 1,
    });

    expect(results).toEqual([]);
    expect(requestedUrl).toBe("https://api.deepseek.com/v1/tools/search");
    expect(requestedHeaders?.Authorization).toBe("Bearer deepseek-secret");
    expect(requestedHeaders?.["content-type"]).toBe("application/json");
    expect(requestedBody).toEqual({
      query: "deepseek search api",
      count: 8,
      need_content: false,
    });
  });

  test("passes query operators through verbatim", async () => {
    let requestedBody: Record<string, unknown> = {};
    const query =
      'DeepSeek site:github.com OR site:huggingface.co -site:example.com "release notes" lang:en after:2025';
    const fetchImpl: FetchLike = async (_url, init) => {
      requestedBody = JSON.parse(String(init?.body));
      return jsonResponse({ results: [] });
    };

    await searchDeepseek(searchInput({ query, freshness: undefined }), fetchImpl, {
      retryBackoffMs: 1,
    });

    expect(requestedBody.query).toBe(query);
  });

  test("maps freshness windows to the documented after: operator", async () => {
    const FRESHNESS_DAYS = { day: 1, week: 7, month: 31, year: 365 } as const;
    for (const [freshness, days] of Object.entries(FRESHNESS_DAYS)) {
      let requestedBody: Record<string, unknown> = {};
      const fetchImpl: FetchLike = async (_url, init) => {
        requestedBody = JSON.parse(String(init?.body));
        return jsonResponse({ results: [] });
      };

      await searchDeepseek(
        searchInput({ freshness: freshness as WebSearchInput["freshness"] }),
        fetchImpl,
        { retryBackoffMs: 1 },
      );

      const expected = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      expect(requestedBody.query).toBe(`deepseek search api after:${expected}`);
    }
  });

  test("normalizes ranked results and skips entries without urls", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse({
        results: [
          {
            rerank_score: 2.4,
            title: "DeepSeek V4 model released",
            url: "https://example.test/v4",
            snippet: "DeepSeek V4 is now available.",
            summary: "A long model-oriented summary that must not leak into the neutral result.",
            content: "",
            site_name: "Example News",
            date: "2026-06-01T00:00:00+00:00",
            authority: 3,
          },
          { title: "Missing url", snippet: "skip" },
          { url: "https://example.test/fallback-title" },
        ],
      });

    expect(await searchDeepseek(searchInput(), fetchImpl, { retryBackoffMs: 1 })).toEqual([
      {
        title: "DeepSeek V4 model released",
        url: "https://example.test/v4",
        snippet: "DeepSeek V4 is now available.",
        publishedAt: "2026-06-01T00:00:00+00:00",
      },
      {
        title: "https://example.test/fallback-title",
        url: "https://example.test/fallback-title",
      },
    ]);
  });

  test("rejects malformed or unexpected search envelopes", async () => {
    await expect(
      searchDeepseek(searchInput(), async () => new Response("not-json"), { retryBackoffMs: 1 }),
    ).rejects.toMatchObject({ provider: "deepseek", code: "BAD_RESPONSE" });
    await expect(
      searchDeepseek(searchInput(), async () => jsonResponse({ results: "nope" }), {
        retryBackoffMs: 1,
      }),
    ).rejects.toMatchObject({ provider: "deepseek", code: "BAD_RESPONSE" });
  });

  test("backs off and retries 429 before succeeding", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls++;
      return calls < 3 ? new Response("slow down", { status: 429 }) : jsonResponse({ results: [] });
    };

    const results = await searchDeepseek(searchInput(), fetchImpl, { retryBackoffMs: 1 });

    expect(calls).toBe(3);
    expect(results).toEqual([]);
  });

  test("exhausting the 429 budget raises RATE_LIMITED", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls++;
      return new Response("slow down", { status: 429 });
    };

    await expect(
      searchDeepseek(searchInput(), fetchImpl, { retryBackoffMs: 1 }),
    ).rejects.toMatchObject({ provider: "deepseek", code: "RATE_LIMITED", status: 429 });
    expect(calls).toBe(3);
  });

  test("maps 402 to a balance error without retrying or leaking the credential", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls++;
      return new Response("insufficient balance", { status: 402 });
    };

    const error = await searchDeepseek(searchInput(), fetchImpl, { retryBackoffMs: 1 }).catch(
      (caught) => caught,
    );

    expect(calls).toBe(1);
    expect(error).toMatchObject({ provider: "deepseek", code: "PAYMENT_REQUIRED", status: 402 });
    expect(String(error.message)).toContain("balance");
    expect(String(error.message)).not.toContain("deepseek-secret");
  });

  test("maps other 4xx and auth failures without blind retries", async () => {
    let notFoundCalls = 0;
    const notFound: FetchLike = async () => {
      notFoundCalls++;
      return new Response("no usable content", { status: 404 });
    };
    await expect(
      searchDeepseek(searchInput(), notFound, { retryBackoffMs: 1 }),
    ).rejects.toMatchObject({ provider: "deepseek", code: "PROVIDER_ERROR", status: 404 });
    expect(notFoundCalls).toBe(1);

    const unauthorized: FetchLike = async () => new Response("denied", { status: 401 });
    const error = await searchDeepseek(searchInput(), unauthorized, { retryBackoffMs: 1 }).catch(
      (caught) => caught,
    );
    expect(error).toMatchObject({ provider: "deepseek", code: "AUTH_FAILED" });
    expect(String(error.message)).not.toContain("deepseek-secret");
  });

  test("propagates bounded transport failures", async () => {
    const hanging: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    await expect(
      searchDeepseek(searchInput({ timeoutMs: 20 }), hanging, { retryBackoffMs: 1 }),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
  });
});

describe("fetchDeepseek", () => {
  test("routes fetch to the documented endpoint and returns markdown with the page title", async () => {
    let requestedUrl = "";
    let requestedHeaders: Record<string, string> | undefined;
    let requestedBody: Record<string, unknown> = {};
    const fetchImpl: FetchLike = async (url, init) => {
      requestedUrl = String(url);
      requestedHeaders = init?.headers as Record<string, string>;
      requestedBody = JSON.parse(String(init?.body));
      return jsonResponse({ title: "Example article", content: "# Example article\n\nBody." });
    };

    const outcome = await fetchDeepseek(fetchInput(), fetchImpl, { retryBackoffMs: 1 });

    expect(requestedUrl).toBe("https://api.deepseek.com/v1/tools/fetch");
    expect(requestedHeaders?.Authorization).toBe("Bearer deepseek-secret");
    expect(requestedBody).toEqual({ url: "https://example.test/page" });
    expect(outcome).toEqual({
      kind: "text",
      content: "# Example article\n\nBody.",
      metadata: { status: 200, title: "Example article" },
    });
  });

  test("omits the metadata title when the page title is empty", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ title: "", content: "Body only." });

    const outcome = await fetchDeepseek(fetchInput(), fetchImpl, { retryBackoffMs: 1 });

    expect(outcome).toEqual({
      kind: "text",
      content: "Body only.",
      metadata: { status: 200 },
    });
  });

  test("rejects malformed fetch envelopes", async () => {
    await expect(
      fetchDeepseek(fetchInput(), async () => new Response("not-json"), { retryBackoffMs: 1 }),
    ).rejects.toMatchObject({ provider: "deepseek", code: "BAD_RESPONSE" });
    await expect(
      fetchDeepseek(fetchInput(), async () => jsonResponse({ title: "no content" }), {
        retryBackoffMs: 1,
      }),
    ).rejects.toMatchObject({ provider: "deepseek", code: "BAD_RESPONSE" });
  });

  test("maps fetch balance and retrieval failures without retries", async () => {
    let balanceCalls = 0;
    const balance: FetchLike = async () => {
      balanceCalls++;
      return new Response("insufficient balance", { status: 402 });
    };
    const balanceError = await fetchDeepseek(fetchInput(), balance, { retryBackoffMs: 1 }).catch(
      (caught) => caught,
    );
    expect(balanceCalls).toBe(1);
    expect(balanceError).toMatchObject({
      provider: "deepseek",
      code: "PAYMENT_REQUIRED",
      status: 402,
    });
    expect(String(balanceError.message)).toContain("balance");
    expect(String(balanceError.message)).not.toContain("deepseek-secret");

    let notFoundCalls = 0;
    const notFound: FetchLike = async () => {
      notFoundCalls++;
      return new Response("blocked or unavailable", { status: 404 });
    };
    await expect(
      fetchDeepseek(fetchInput(), notFound, { retryBackoffMs: 1 }),
    ).rejects.toMatchObject({ provider: "deepseek", code: "PROVIDER_ERROR", status: 404 });
    expect(notFoundCalls).toBe(1);
  });

  test("retries fetch 429 within the bounded budget", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls++;
      return calls === 1
        ? new Response("slow down", { status: 429 })
        : jsonResponse({ title: "Example", content: "# Example" });
    };

    const outcome = await fetchDeepseek(fetchInput(), fetchImpl, { retryBackoffMs: 1 });

    expect(calls).toBe(2);
    expect(outcome.kind).toBe("text");
  });
});
