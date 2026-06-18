---
"@web-widget/http-cache-semantics": patch
---

Fix `evaluateRequest()` and `satisfiesWithoutRevalidation()` incorrectly forcing revalidation for fresh entries with `Cache-Control: must-revalidate`. Per RFC 9111 §5.2.2.2, `must-revalidate` only restricts reuse of stale entries; fresh responses may be served without contacting the origin.
