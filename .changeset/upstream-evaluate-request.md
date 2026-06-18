---
"@web-widget/http-cache-semantics": major
---

Merge upstream kornelski/http-cache-semantics v4.2.0: add `evaluateRequest()` for stale-while-revalidate support, fix min-fresh and must-revalidate handling, and preserve constructor options in `revalidatedPolicy()`.

Remove unused `trustServerDate` option.

**Breaking:** Remove `CacheQueryOptions` and public `useStaleIfError()`. Normalize the `Request` at the cache layer before calling `evaluateRequest()`; use `revalidatedPolicy()` for stale-if-error handling.
