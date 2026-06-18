# @web-widget/http-cache-semantics

## 2.0.1

### Patch Changes

- ed6da9e: Fix `evaluateRequest()` and `satisfiesWithoutRevalidation()` incorrectly forcing revalidation for fresh entries with `Cache-Control: must-revalidate`. Per RFC 9111 §5.2.2.2, `must-revalidate` only restricts reuse of stale entries; fresh responses may be served without contacting the origin.

## 2.0.0

### Major Changes

- bb77a6b: Merge upstream kornelski/http-cache-semantics v4.2.0: add `evaluateRequest()` for stale-while-revalidate support, fix min-fresh and must-revalidate handling, and preserve constructor options in `revalidatedPolicy()`.

  Remove unused `trustServerDate` option.

  **Breaking:** Remove `CacheQueryOptions` and public `useStaleIfError()`. Normalize the `Request` at the cache layer before calling `evaluateRequest()`; use `revalidatedPolicy()` for stale-if-error handling.

## 1.2.0

### Minor Changes

- bf77ffd: Support `ignoreMethod` and `ignoreVary` options.

## 1.1.0

### Minor Changes

- 8bcc0a0: Add cache query option.

## 1.0.0

### Major Changes

- 03c0077: Removed some non-essential fields in package.json.

## 0.0.4

### Patch Changes

- ab4dc5c: Public `useStaleIfError` method.

## 0.0.3

### Patch Changes

- 09a7e00: Add some comments and type definitions.

## 0.0.2

### Patch Changes

- 796f803: Supports web standard `Request` and `Response` objects.
