// src/index.ts
var statusCodeCacheableByDefault = /* @__PURE__ */ new Set([
  200,
  203,
  204,
  206,
  300,
  301,
  308,
  404,
  405,
  410,
  414,
  501
]);
var understoodStatuses = /* @__PURE__ */ new Set([
  200,
  203,
  204,
  300,
  301,
  302,
  303,
  307,
  308,
  404,
  405,
  410,
  414,
  501
]);
var errorStatusCodes = /* @__PURE__ */ new Set([
  500,
  502,
  503,
  504
]);
var hopByHopHeaders = {
  date: true,
  // included, because we add Age update Date
  connection: true,
  "keep-alive": true,
  "proxy-authenticate": true,
  "proxy-authorization": true,
  te: true,
  trailer: true,
  "transfer-encoding": true,
  upgrade: true
};
var excludedFromRevalidationUpdate = {
  // Since the old body is reused, it doesn't make sense to change properties of the body
  "content-length": true,
  "content-encoding": true,
  "transfer-encoding": true,
  "content-range": true
};
function toNumberOrZero(s) {
  const n = parseInt(s, 10);
  return isFinite(n) ? n : 0;
}
function isErrorResponse(response) {
  if (!response) {
    return true;
  }
  return errorStatusCodes.has(response.status);
}
function parseCacheControl(header) {
  const cc = {};
  if (!header)
    return cc;
  const parts = header.trim().split(/,/);
  for (const part of parts) {
    const [k, v] = part.split(/=/, 2);
    cc[k.trim()] = v === void 0 ? true : v.trim().replace(/^"|"$/g, "");
  }
  return cc;
}
function formatCacheControl(cc) {
  let parts = [];
  for (const k in cc) {
    const v = cc[k];
    parts.push(v === true ? k : k + "=" + v);
  }
  if (!parts.length) {
    return null;
  }
  return parts.join(", ");
}
function headersToObject(headers) {
  let obj = {};
  for (let [key, value] of headers.entries()) {
    obj[key] = value;
  }
  return obj;
}
var CachePolicy = class _CachePolicy {
  #responseTime;
  #isShared;
  #cacheHeuristic;
  #immutableMinTtl;
  #status;
  #resHeaders;
  #resCacheControl;
  #method;
  #url;
  #host;
  #noAuthorization;
  #reqCacheControl;
  #reqHeaders;
  constructor(req, res, {
    shared,
    cacheHeuristic,
    immutableMinTimeToLive,
    ignoreCargoCult,
    _fromObject
  } = {}) {
    if (_fromObject) {
      this.#fromObject(_fromObject);
      return;
    }
    if (!res || !res.headers) {
      throw Error("Response headers missing");
    }
    this.#assertRequestHasHeaders(req);
    this.#responseTime = this.now();
    this.#isShared = shared !== false;
    this.#cacheHeuristic = void 0 !== cacheHeuristic ? cacheHeuristic : 0.1;
    this.#immutableMinTtl = void 0 !== immutableMinTimeToLive ? immutableMinTimeToLive : 24 * 3600 * 1e3;
    this.#status = "status" in res ? res.status : 200;
    this.#resHeaders = res.headers;
    this.#resCacheControl = parseCacheControl(res.headers.get("cache-control"));
    this.#method = "method" in req ? req.method : "GET";
    this.#url = req.url;
    this.#host = req.headers.get("host");
    this.#noAuthorization = !req.headers.has("authorization");
    this.#reqHeaders = res.headers.has("vary") ? req.headers : null;
    this.#reqCacheControl = parseCacheControl(req.headers.get("cache-control"));
    if (ignoreCargoCult && "pre-check" in this.#resCacheControl && "post-check" in this.#resCacheControl) {
      delete this.#resCacheControl["pre-check"];
      delete this.#resCacheControl["post-check"];
      delete this.#resCacheControl["no-cache"];
      delete this.#resCacheControl["no-store"];
      delete this.#resCacheControl["must-revalidate"];
      this.#resHeaders = new Headers(this.#resHeaders);
      const resCacheControl = formatCacheControl(this.#resCacheControl);
      if (resCacheControl) {
        this.#resHeaders.set("cache-control", resCacheControl);
      } else {
        this.#resHeaders.delete("cache-control");
      }
      this.#resHeaders.delete("expires");
      this.#resHeaders.delete("pragma");
    }
    if (res.headers.get("cache-control") == null && /no-cache/.test(res.headers.get("pragma") ?? "")) {
      this.#resCacheControl["no-cache"] = true;
    }
  }
  now() {
    return Date.now();
  }
  storable() {
    return !!(!this.#reqCacheControl["no-store"] && // A cache MUST NOT store a response to any request, unless:
    // The request method is understood by the cache and defined as being cacheable, and
    ("GET" === this.#method || "HEAD" === this.#method || "POST" === this.#method && this.#hasExplicitExpiration()) && // the response status code is understood by the cache, and
    understoodStatuses.has(this.#status) && // the "no-store" cache directive does not appear in request or response header fields, and
    !this.#resCacheControl["no-store"] && // the "private" response directive does not appear in the response, if the cache is shared, and
    (!this.#isShared || !this.#resCacheControl.private) && // the Authorization header field does not appear in the request, if the cache is shared,
    (!this.#isShared || this.#noAuthorization || this.#allowsStoringAuthenticated()) && // the response either:
    // contains an Expires header field, or
    (this.#resHeaders.has("expires") || // contains a max-age response directive, or
    // contains a s-maxage response directive and the cache is shared, or
    // contains a public response directive.
    this.#resCacheControl["max-age"] || this.#isShared && this.#resCacheControl["s-maxage"] || this.#resCacheControl.public || // has a status code that is defined as cacheable by default
    statusCodeCacheableByDefault.has(this.#status)));
  }
  #hasExplicitExpiration() {
    return this.#isShared && this.#resCacheControl["s-maxage"] || this.#resCacheControl["max-age"] || this.#resHeaders.has("expires");
  }
  #assertRequestHasHeaders(req) {
    if (!req || !req.headers) {
      throw Error("Request headers missing");
    }
  }
  satisfiesWithoutRevalidation(req) {
    this.#assertRequestHasHeaders(req);
    const reqCacheControl = parseCacheControl(req.headers.get("cache-control"));
    if (reqCacheControl["no-cache"] || /no-cache/.test(req.headers.get("pragma") ?? "")) {
      return false;
    }
    if (reqCacheControl["max-age"] && this.age() > Number(reqCacheControl["max-age"])) {
      return false;
    }
    if (reqCacheControl["min-fresh"] && this.timeToLive() < 1e3 * Number(reqCacheControl["min-fresh"])) {
      return false;
    }
    if (this.stale()) {
      const allowsStale = reqCacheControl["max-stale"] && !this.#resCacheControl["must-revalidate"] && (true === reqCacheControl["max-stale"] || Number(reqCacheControl["max-stale"]) > this.age() - this.maxAge());
      if (!allowsStale) {
        return false;
      }
    }
    return this.#requestMatches(req, false);
  }
  #requestMatches(req, allowHeadMethod) {
    return (!this.#url || this.#url === req.url) && this.#host === req.headers.get("host") && // the request method associated with the stored response allows it to be used for the presented request, and
    (!req.method || this.#method === req.method || allowHeadMethod && "HEAD" === req.method) && // selecting header fields nominated by the stored response (if any) match those presented, and
    this.#varyMatches(req);
  }
  #allowsStoringAuthenticated() {
    return this.#resCacheControl["must-revalidate"] || this.#resCacheControl.public || this.#resCacheControl["s-maxage"];
  }
  #varyMatches(req) {
    if (!this.#resHeaders.has("vary")) {
      return true;
    }
    if (this.#resHeaders.get("vary") === "*") {
      return false;
    }
    const fields = this.#resHeaders.get("vary").trim().toLowerCase().split(/\s*,\s*/);
    for (const name of fields) {
      if (req.headers.get(name) !== this.#reqHeaders?.get(name))
        return false;
    }
    return true;
  }
  #copyWithoutHopByHopHeaders(inHeaders) {
    const headers = new Headers();
    inHeaders.forEach((value, name) => {
      if (hopByHopHeaders[name])
        return;
      headers.set(name, value);
    });
    if (inHeaders.has("connection")) {
      const tokens = inHeaders.get("connection").trim().split(/\s*,\s*/);
      for (const name of tokens) {
        headers.delete(name);
      }
    }
    if (headers.has("warning")) {
      const warnings = headers.get("warning").split(/,/).filter((warning) => {
        return !/^\s*1[0-9][0-9]/.test(warning);
      });
      if (!warnings.length) {
        headers.delete("warning");
      } else {
        headers.set("warning", warnings.join(",").trim());
      }
    }
    return headers;
  }
  responseHeaders() {
    const headers = this.#copyWithoutHopByHopHeaders(this.#resHeaders);
    const age = this.age();
    if (age > 3600 * 24 && !this.#hasExplicitExpiration() && this.maxAge() > 3600 * 24) {
      headers.set("warning", (headers.has("warning") ? `${headers.get("warning")}, ` : "") + '113 - "rfc7234 5.5.4"');
    }
    headers.set("age", `${Math.round(age)}`);
    headers.set("date", new Date(this.now()).toUTCString());
    return headers;
  }
  /**
   * Value of the Date response header or current time if Date was invalid
   */
  date() {
    const serverDate = Date.parse(this.#resHeaders.get("date") ?? "");
    if (isFinite(serverDate)) {
      return serverDate;
    }
    return this.#responseTime;
  }
  /**
   * Value of the Age header, in seconds, updated for the current time.
   * May be fractional.
   */
  age() {
    let age = this.#ageValue();
    const residentTime = (this.now() - this.#responseTime) / 1e3;
    return age + residentTime;
  }
  #ageValue() {
    return toNumberOrZero(this.#resHeaders.get("age") ?? "");
  }
  /**
   * Possibly outdated value of applicable max-age (or heuristic equivalent) in seconds.
   * This counts since response's `Date`.
   *
   * For an up-to-date value, see `timeToLive()`.
   */
  maxAge() {
    if (!this.storable() || this.#resCacheControl["no-cache"]) {
      return 0;
    }
    if (this.#isShared && (this.#resHeaders.has("set-cookie") && !this.#resCacheControl.public && !this.#resCacheControl.immutable)) {
      return 0;
    }
    if (this.#resHeaders.get("vary") === "*") {
      return 0;
    }
    if (this.#isShared) {
      if (this.#resCacheControl["proxy-revalidate"]) {
        return 0;
      }
      if (this.#resCacheControl["s-maxage"]) {
        return toNumberOrZero(this.#resCacheControl["s-maxage"]);
      }
    }
    if (this.#resCacheControl["max-age"]) {
      return toNumberOrZero(this.#resCacheControl["max-age"]);
    }
    const defaultMinTtl = this.#resCacheControl.immutable ? this.#immutableMinTtl : 0;
    const serverDate = this.date();
    if (this.#resHeaders.has("expires")) {
      const expires = Date.parse(this.#resHeaders.get("expires"));
      if (Number.isNaN(expires) || expires < serverDate) {
        return 0;
      }
      return Math.max(defaultMinTtl, (expires - serverDate) / 1e3);
    }
    if (this.#resHeaders.has("last-modified")) {
      const lastModified = Date.parse(this.#resHeaders.get("last-modified"));
      if (isFinite(lastModified) && serverDate > lastModified) {
        return Math.max(
          defaultMinTtl,
          (serverDate - lastModified) / 1e3 * this.#cacheHeuristic
        );
      }
    }
    return defaultMinTtl;
  }
  /**
   * Up-to-date `max-age` value, in *milliseconds*.
   *
   * Prefer this method over `maxAge()`.
   */
  timeToLive() {
    const age = this.maxAge() - this.age();
    const staleIfErrorAge = age + toNumberOrZero(this.#resCacheControl["stale-if-error"]);
    const staleWhileRevalidateAge = age + toNumberOrZero(this.#resCacheControl["stale-while-revalidate"]);
    return Math.round(Math.max(0, age, staleIfErrorAge, staleWhileRevalidateAge) * 1e3);
  }
  stale() {
    return this.maxAge() <= this.age();
  }
  #useStaleIfError() {
    return this.maxAge() + toNumberOrZero(this.#resCacheControl["stale-if-error"]) > this.age();
  }
  useStaleWhileRevalidate() {
    return this.maxAge() + toNumberOrZero(this.#resCacheControl["stale-while-revalidate"]) > this.age();
  }
  static fromObject(obj) {
    return new this(void 0, void 0, { _fromObject: obj });
  }
  #fromObject(obj) {
    if (this.#responseTime)
      throw Error("Reinitialized");
    if (!obj || obj.v !== 1)
      throw Error("Invalid serialization");
    this.#responseTime = obj.t;
    this.#isShared = obj.sh;
    this.#cacheHeuristic = obj.ch;
    this.#immutableMinTtl = obj.imm !== void 0 ? obj.imm : 24 * 3600 * 1e3;
    this.#status = obj.st;
    this.#resHeaders = new Headers(obj.resh);
    this.#resCacheControl = obj.rescc;
    this.#method = obj.m;
    this.#url = obj.u;
    this.#host = obj.h;
    this.#noAuthorization = obj.a;
    this.#reqHeaders = obj.reqh ? new Headers(obj.reqh) : null;
    this.#reqCacheControl = obj.reqcc;
  }
  toObject() {
    return {
      v: 1,
      t: this.#responseTime,
      sh: this.#isShared,
      ch: this.#cacheHeuristic,
      imm: this.#immutableMinTtl,
      st: this.#status,
      resh: headersToObject(this.#resHeaders),
      rescc: this.#resCacheControl,
      m: this.#method,
      u: this.#url,
      h: this.#host,
      a: this.#noAuthorization,
      reqh: this.#reqHeaders ? headersToObject(this.#reqHeaders) : null,
      reqcc: this.#reqCacheControl
    };
  }
  /**
   * Headers for sending to the origin server to revalidate stale response.
   * Allows server to return 304 to allow reuse of the previous response.
   *
   * Hop by hop headers are always stripped.
   * Revalidation headers may be added or removed, depending on request.
   */
  revalidationHeaders(req) {
    this.#assertRequestHasHeaders(req);
    const headers = this.#copyWithoutHopByHopHeaders(req.headers);
    headers.delete("if-range");
    if (!this.#requestMatches(req, true) || !this.storable()) {
      headers.delete("if-none-match");
      headers.delete("if-modified-since");
      return headers;
    }
    if (this.#resHeaders.has("etag")) {
      headers.set("if-none-match", headers.has("if-none-match") ? `${headers.get("if-none-match")}, ${this.#resHeaders.get("etag")}` : this.#resHeaders.get("etag"));
    }
    const forbidsWeakValidators = headers.get("accept-ranges") || headers.get("if-match") || headers.get("if-unmodified-since") || this.#method && this.#method !== "GET";
    if (forbidsWeakValidators) {
      headers.delete("if-modified-since");
      if (headers.has("if-none-match")) {
        const etags = headers.get("if-none-match").split(/,/).filter((etag) => {
          return !/^\s*W\//.test(etag);
        });
        if (!etags.length) {
          headers.delete("if-none-match");
        } else {
          headers.set("if-none-match", etags.join(",").trim());
        }
      }
    } else if (this.#resHeaders.has("last-modified") && !headers.has("if-modified-since")) {
      headers.set("if-modified-since", this.#resHeaders.get("last-modified"));
    }
    return headers;
  }
  /**
   * Creates new CachePolicy with information combined from the previews response,
   * and the new revalidation response.
   *
   * Returns {policy, modified} where modified is a boolean indicating
   * whether the response body has been modified, and old cached body can't be used.
   */
  revalidatedPolicy(request, response) {
    this.#assertRequestHasHeaders(request);
    if (this.#useStaleIfError() && isErrorResponse(response)) {
      return {
        modified: false,
        matches: false,
        policy: this
      };
    }
    if (!response || !response.headers) {
      throw Error("Response headers missing");
    }
    let matches = false;
    if (response.status !== 304) {
      matches = false;
    } else if (response.headers.has("etag") && !/^\s*W\//.test(response.headers.get("etag"))) {
      matches = this.#resHeaders.has("etag") && this.#resHeaders.get("etag").replace(/^\s*W\//, "") === response.headers.get("etag");
    } else if (this.#resHeaders.has("etag") && response.headers.has("etag")) {
      matches = this.#resHeaders.get("etag").replace(/^\s*W\//, "") === response.headers.get("etag").replace(/^\s*W\//, "");
    } else if (this.#resHeaders.has("last-modified")) {
      matches = this.#resHeaders.get("last-modified") === response.headers.get("last-modified");
    } else {
      if (!this.#resHeaders.has("etag") && !this.#resHeaders.has("last-modified") && !response.headers.has("etag") && !response.headers.has("last-modified")) {
        matches = true;
      }
    }
    if (!matches) {
      return {
        policy: new _CachePolicy(request, response),
        // Client receiving 304 without body, even if it's invalid/mismatched has no option
        // but to reuse a cached body. We don't have a good way to tell clients to do
        // error recovery in such case.
        modified: response.status !== 304,
        matches: false
      };
    }
    const headers = {};
    this.#resHeaders.forEach((v, k) => {
      headers[k] = response.headers.has(k) && !excludedFromRevalidationUpdate[k] ? response.headers.get(k) : v;
    });
    const newResponse = new Response(response.body, {
      status: this.#status,
      // method: this.#method,
      headers
    });
    return {
      policy: new _CachePolicy(request, newResponse, {
        shared: this.#isShared,
        cacheHeuristic: this.#cacheHeuristic,
        immutableMinTimeToLive: this.#immutableMinTtl
      }),
      modified: false,
      matches: true
    };
  }
};
export {
  CachePolicy as default
};
