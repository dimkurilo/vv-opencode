// FILE: src/plugins/web-tools/providers/deepseek.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Call the documented DeepSeek Search and Fetch Tool APIs directly and normalize ranked results and Markdown page content for the provider-neutral web tools.
//   SCOPE: Bearer-authenticated search and fetch requests on the shared DeepSeek API base URL, query-operator pass-through with freshness mapped to the documented after: operator, need_content kept false so full pages go through the Fetch API, bounded 429 backoff-and-retry, response normalization, and provider error mapping without MCP behavior.
//   DEPENDS: [src/plugins/web-tools/config.ts, src/plugins/web-tools/http.ts, src/plugins/web-tools/providers/exa.ts]
//   LINKS: [M-WEB-DEEPSEEK, M-WEB-HTTP, M-WEB-SEARCH-SERVICE, M-WEB-FETCH-SERVICE]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   DeepseekFetchOutcome - Markdown text result returned by the DeepSeek fetch adapter.
//   searchDeepseek - Execute one direct DeepSeek web search request.
//   fetchDeepseek - Read one page through the direct DeepSeek fetch endpoint.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [direct change - Added the direct DeepSeek Search and Fetch Tool API integration with operator pass-through, freshness mapping, bounded 429 retry, and credential-safe errors.]
// END_CHANGE_SUMMARY

import type { WebProviderCredential } from "../config.js";
import {
  DEFAULT_TEXT_MAX_BYTES,
  requestBounded,
  WebHttpError,
  type BoundedHttpRequest,
  type BoundedHttpResponse,
  type FetchLike,
} from "../http.js";
import {
  mapHttpErrorToProviderError,
  WebProviderError,
  type WebSearchInput,
  type WebSearchResult,
} from "./exa.js";

const DEEPSEEK_SEARCH_URL = "https://api.deepseek.com/v1/tools/search";
const DEEPSEEK_FETCH_URL = "https://api.deepseek.com/v1/tools/fetch";

const DEEPSEEK_RATE_LIMIT_STATUS = 429;
const DEEPSEEK_MAX_ATTEMPTS = 3;
const DEEPSEEK_RETRY_BACKOFF_MS = 500;

const FRESHNESS_DAYS = { day: 1, week: 7, month: 31, year: 365 } as const;

/** Text outcome of the DeepSeek fetch adapter: the page title (when available) plus Markdown content. */
export type DeepseekFetchOutcome = {
  kind: "text";
  content: string;
  metadata: {
    status: number;
    title?: string;
  };
};

// START_BLOCK_HELPERS
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function freshnessDate(freshness: keyof typeof FRESHNESS_DAYS): string {
  const ms = Date.now() - FRESHNESS_DAYS[freshness] * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The DeepSeek query is forwarded with its search syntax intact, so freshness
 * maps to the documented after: operator appended to the verbatim query.
 */
function searchQuery(query: string, freshness: WebSearchInput["freshness"]): string {
  if (!freshness) {
    return query;
  }
  return `${query} after:${freshnessDate(freshness)}`;
}

function decodeJson(bytes: Uint8Array, operation: "search" | "fetch"): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new WebProviderError(
      "deepseek",
      "BAD_RESPONSE",
      `malformed JSON response from deepseek ${operation}`,
    );
  }
}

function normalizeSearchResult(item: unknown): WebSearchResult | undefined {
  if (!isPlainObject(item)) {
    return undefined;
  }
  const url = typeof item.url === "string" && item.url.length > 0 ? item.url : undefined;
  if (!url) {
    return undefined;
  }
  const title = typeof item.title === "string" && item.title.length > 0 ? item.title : url;
  const snippet =
    typeof item.snippet === "string" && item.snippet.length > 0 ? item.snippet : undefined;
  const publishedAt = typeof item.date === "string" && item.date.length > 0 ? item.date : undefined;
  return {
    title,
    url,
    ...(snippet ? { snippet } : {}),
    ...(publishedAt ? { publishedAt } : {}),
  };
}

function parseSearchResponse(bytes: Uint8Array): WebSearchResult[] {
  const parsed = decodeJson(bytes, "search");
  if (!isPlainObject(parsed) || !Array.isArray(parsed.results)) {
    throw new WebProviderError(
      "deepseek",
      "BAD_RESPONSE",
      "unexpected deepseek search response envelope",
    );
  }
  return (parsed.results as unknown[])
    .map(normalizeSearchResult)
    .filter((result): result is WebSearchResult => result !== undefined);
}

/**
 * Execute one bounded request, backing off and retrying only the documented
 * rate-limit status before the attempt budget is exhausted. Other failures
 * surface immediately through the shared credential-safe provider mapping.
 */
async function requestWithRateLimitRetry(
  request: BoundedHttpRequest,
  fetchImpl: FetchLike | undefined,
  retryBackoffMs: number,
): Promise<BoundedHttpResponse> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await requestBounded(request, fetchImpl);
    } catch (error) {
      const retryable =
        error instanceof WebHttpError &&
        error.code === "HTTP_ERROR" &&
        error.status === DEEPSEEK_RATE_LIMIT_STATUS &&
        attempt < DEEPSEEK_MAX_ATTEMPTS;
      if (!retryable) {
        mapHttpErrorToProviderError(error, "deepseek");
        throw error;
      }
      await sleep(retryBackoffMs * attempt);
    }
  }
}
// END_BLOCK_HELPERS

// START_CONTRACT: searchDeepseek
//   PURPOSE: Search through the documented direct DeepSeek Search Tool API with query operators passed through and need_content kept false.
//   INPUTS: { input: provider-neutral search input; fetchImpl: injectable fetch; options.retryBackoffMs: test-injectable 429 backoff }
//   OUTPUTS: { WebSearchResult[] - normalized provider-ranked results, empty array when none }
//   SIDE_EFFECTS: performs bounded authenticated HTTP requests with up to two 429 backoff retries; never logs the credential
//   LINKS: M-WEB-SEARCH-SERVICE
// END_CONTRACT: searchDeepseek
export async function searchDeepseek(
  input: WebSearchInput,
  fetchImpl?: FetchLike,
  options?: { retryBackoffMs?: number },
): Promise<WebSearchResult[]> {
  const body = JSON.stringify({
    query: searchQuery(input.query, input.freshness),
    count: input.count,
    need_content: false,
  });

  const response = await requestWithRateLimitRetry(
    {
      url: DEEPSEEK_SEARCH_URL,
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.credential.value}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body,
      timeoutMs: input.timeoutMs,
      maxBytes: DEFAULT_TEXT_MAX_BYTES,
      abort: input.abort,
    },
    fetchImpl,
    options?.retryBackoffMs ?? DEEPSEEK_RETRY_BACKOFF_MS,
  );

  return parseSearchResponse(response.bytes);
}

// START_CONTRACT: fetchDeepseek
//   PURPOSE: Read one page through the documented direct DeepSeek Fetch endpoint and return its Markdown content.
//   INPUTS: { input: url, credential, abort, timeoutMs; fetchImpl: injectable fetch; options.retryBackoffMs: test-injectable 429 backoff }
//   OUTPUTS: { DeepseekFetchOutcome - Markdown content plus status and optional page title }
//   SIDE_EFFECTS: performs bounded authenticated HTTP requests with up to two 429 backoff retries; never logs the credential
//   LINKS: M-WEB-FETCH-SERVICE
// END_CONTRACT: fetchDeepseek
export async function fetchDeepseek(
  input: {
    url: string;
    credential: WebProviderCredential;
    abort: AbortSignal;
    timeoutMs: number;
  },
  fetchImpl?: FetchLike,
  options?: { retryBackoffMs?: number },
): Promise<DeepseekFetchOutcome> {
  const body = JSON.stringify({ url: input.url });

  const response = await requestWithRateLimitRetry(
    {
      url: DEEPSEEK_FETCH_URL,
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.credential.value}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body,
      timeoutMs: input.timeoutMs,
      maxBytes: DEFAULT_TEXT_MAX_BYTES,
      abort: input.abort,
    },
    fetchImpl,
    options?.retryBackoffMs ?? DEEPSEEK_RETRY_BACKOFF_MS,
  );

  const parsed = decodeJson(response.bytes, "fetch");
  if (!isPlainObject(parsed) || typeof parsed.content !== "string") {
    throw new WebProviderError(
      "deepseek",
      "BAD_RESPONSE",
      "unexpected deepseek fetch response envelope",
    );
  }
  const title =
    typeof parsed.title === "string" && parsed.title.length > 0 ? parsed.title : undefined;
  return {
    kind: "text",
    content: parsed.content,
    metadata: {
      status: response.status,
      ...(title ? { title } : {}),
    },
  };
}
