// rfc7231 6.1
const statusCodeCacheableByDefault = new Set([
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
    501,
]);

// This implementation does not understand partial responses (206)
const understoodStatuses = new Set([
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
    501,
]);

const errorStatusCodes = new Set([
    500,
    502,
    503, 
    504,
]);

const hopByHopHeaders: Record<string, boolean> = {
    date: true, // included, because we add Age update Date
    connection: true,
    'keep-alive': true,
    'proxy-authenticate': true,
    'proxy-authorization': true,
    te: true,
    trailer: true,
    'transfer-encoding': true,
    upgrade: true,
};

const excludedFromRevalidationUpdate: Record<string, boolean> = {
    // Since the old body is reused, it doesn't make sense to change properties of the body
    'content-length': true,
    'content-encoding': true,
    'transfer-encoding': true,
    'content-range': true,
};

function toNumberOrZero(s: string) {
    const n = parseInt(s, 10);
    return isFinite(n) ? n : 0;
}

// RFC 5861
function isErrorResponse(response?: Response) {
    // consider undefined response as faulty
    if(!response) {
        return true
    }
    return errorStatusCodes.has(response.status);
}

function parseCacheControl(header: string | null) {
    const cc: Record<string, boolean | string> = {};
    if (!header) return cc;

    // TODO: When there is more than one value present for a given directive (e.g., two Expires header fields, multiple Cache-Control: max-age directives),
    // the directive's value is considered invalid. Caches are encouraged to consider responses that have invalid freshness information to be stale
    const parts = header.trim().split(/,/);
    for (const part of parts) {
        const [k, v] = part.split(/=/, 2);
        cc[k.trim()] = v === undefined ? true : v.trim().replace(/^"|"$/g, '');
    }

    return cc;
}

function formatCacheControl(cc: Record<string, boolean | string>) {
    let parts = [];
    for (const k in cc) {
        const v = cc[k];
        parts.push(v === true ? k : k + '=' + v);
    }
    if (!parts.length) {
        return undefined;
    }
    return parts.join(', ');
}

export default class CachePolicy {
    #responseTime: number;
    #isShared: boolean;
    #cacheHeuristic: number;
    #immutableMinTtl: number;
    #status: number;
    #resHeaders: Headers;
    #resCacheControl: Record<string, string | boolean>;
    #method: string;
    #url: string;
    #host: string | null;
    #noAuthorization: boolean;
    #reqCacheControl: Record<string, string | boolean>;
    #reqHeaders: Headers | null;
    constructor(
        req: Request,
        res: Response,
        {
            shared,
            cacheHeuristic,
            immutableMinTimeToLive,
            ignoreCargoCult,
            _fromObject,
        }: {
            shared?: boolean,
            cacheHeuristic?: number,
            immutableMinTimeToLive?: number,
            ignoreCargoCult?: boolean,
            _fromObject?: any
        } = {}
    ) {
        if (_fromObject) {
            this.#fromObject(_fromObject);
            return;
        }

        if (!res || !res.headers) {
            throw Error('Response headers missing');
        }
        this.#assertRequestHasHeaders(req);

        this.#responseTime = this.now();
        this.#isShared = shared !== false;
        this.#cacheHeuristic =
            undefined !== cacheHeuristic ? cacheHeuristic : 0.1; // 10% matches IE
        this.#immutableMinTtl =
            undefined !== immutableMinTimeToLive
                ? immutableMinTimeToLive
                : 24 * 3600 * 1000;

        this.#status = 'status' in res ? res.status : 200;
        this.#resHeaders = res.headers;
        this.#resCacheControl = parseCacheControl(res.headers.get('cache-control'));
        this.#method = req.method ?? 'GET';
        this.#url = req.url;
        this.#host = req.headers.get('host');
        this.#noAuthorization = !req.headers.has('authorization');
        this.#reqHeaders = res.headers.has('vary') ? req.headers : null; // Don't keep all request headers if they won't be used
        this.#reqCacheControl = parseCacheControl(req.headers.get('cache-control'));

        // Assume that if someone uses legacy, non-standard uncecessary options they don't understand caching,
        // so there's no point stricly adhering to the blindly copy&pasted directives.
        if (
            ignoreCargoCult &&
            'pre-check' in this.#resCacheControl &&
            'post-check' in this.#resCacheControl
        ) {
            delete this.#resCacheControl['pre-check'];
            delete this.#resCacheControl['post-check'];
            delete this.#resCacheControl['no-cache'];
            delete this.#resCacheControl['no-store'];
            delete this.#resCacheControl['must-revalidate'];
            this.#resHeaders = Object.assign({}, this.#resHeaders, {
                'cache-control': formatCacheControl(this.#resCacheControl),
            });
            this.#resHeaders.delete('expires');
            this.#resHeaders.delete('pragma');
        }

        // When the Cache-Control header field is not present in a request, caches MUST consider the no-cache request pragma-directive
        // as having the same effect as if "Cache-Control: no-cache" were present (see Section 5.2.1).
        if (
            res.headers.get('cache-control') == null &&
            /no-cache/.test(res.headers.get('pragma') ?? '')
        ) {
            this.#resCacheControl['no-cache'] = true;
        }
    }

    now() {
        return Date.now();
    }

    storable() {
        // The "no-store" request directive indicates that a cache MUST NOT store any part of either this request or any response to it.
        return !!(
            !this.#reqCacheControl['no-store'] &&
            // A cache MUST NOT store a response to any request, unless:
            // The request method is understood by the cache and defined as being cacheable, and
            ('GET' === this.#method ||
                'HEAD' === this.#method ||
                ('POST' === this.#method && this.#hasExplicitExpiration())) &&
            // the response status code is understood by the cache, and
            understoodStatuses.has(this.#status) &&
            // the "no-store" cache directive does not appear in request or response header fields, and
            !this.#resCacheControl['no-store'] &&
            // the "private" response directive does not appear in the response, if the cache is shared, and
            (!this.#isShared || !this.#resCacheControl.private) &&
            // the Authorization header field does not appear in the request, if the cache is shared,
            (!this.#isShared ||
                this.#noAuthorization ||
                this.#allowsStoringAuthenticated()) &&
            // the response either:
            // contains an Expires header field, or
            (this.#resHeaders.get('expires') ||
                // contains a max-age response directive, or
                // contains a s-maxage response directive and the cache is shared, or
                // contains a public response directive.
                this.#resCacheControl['max-age'] ||
                (this.#isShared && this.#resCacheControl['s-maxage']) ||
                this.#resCacheControl.public ||
                // has a status code that is defined as cacheable by default
                statusCodeCacheableByDefault.has(this.#status))
        );
    }

    #hasExplicitExpiration() {
        // 4.2.1 Calculating Freshness Lifetime
        return (
            (this.#isShared && this.#resCacheControl['s-maxage']) ||
            this.#resCacheControl['max-age'] ||
            this.#resHeaders.has('expires')
        );
    }

    #assertRequestHasHeaders(req: Request) {
        if (!req || !req.headers) {
            throw Error('Request headers missing');
        }
    }

    satisfiesWithoutRevalidation(req: Request) {
        this.#assertRequestHasHeaders(req);

        // When presented with a request, a cache MUST NOT reuse a stored response, unless:
        // the presented request does not contain the no-cache pragma (Section 5.4), nor the no-cache cache directive,
        // unless the stored response is successfully validated (Section 4.3), and
        const requestCC = parseCacheControl(req.headers.get('cache-control'));
        if (requestCC['no-cache'] || /no-cache/.test(req.headers.get('pragma') ?? '')) {
            return false;
        }

        if (requestCC['max-age'] && this.age() > Number(requestCC['max-age'])) {
            return false;
        }

        if (
            requestCC['min-fresh'] &&
            this.timeToLive() < 1000 * Number(requestCC['min-fresh'])
        ) {
            return false;
        }

        // the stored response is either:
        // fresh, or allowed to be served stale
        if (this.stale()) {
            const allowsStale =
                requestCC['max-stale'] &&
                !this.#resCacheControl['must-revalidate'] &&
                (true === requestCC['max-stale'] ||
                    Number(requestCC['max-stale']) > this.age() - this.maxAge());
            if (!allowsStale) {
                return false;
            }
        }

        return this.#requestMatches(req, false);
    }

    #requestMatches(req: Request, allowHeadMethod: boolean) {
        // The presented effective request URI and that of the stored response match, and
        return (
            (!this.#url || this.#url === req.url) &&
            this.#host === req.headers.get('host') &&
            // the request method associated with the stored response allows it to be used for the presented request, and
            (!req.method ||
                this.#method === req.method ||
                (allowHeadMethod && 'HEAD' === req.method)) &&
            // selecting header fields nominated by the stored response (if any) match those presented, and
            this.#varyMatches(req)
        );
    }

    #allowsStoringAuthenticated() {
        //  following Cache-Control response directives (Section 5.2.2) have such an effect: must-revalidate, public, and s-maxage.
        return (
            this.#resCacheControl['must-revalidate'] ||
            this.#resCacheControl.public ||
            this.#resCacheControl['s-maxage']
        );
    }

    #varyMatches(req: Request) {
        if (!this.#resHeaders.has('vary')) {
            return true;
        }

        // A Vary header field-value of "*" always fails to match
        if (this.#resHeaders.get('vary') === '*') {
            return false;
        }

        const fields = (this.#resHeaders.get('vary')!)
            .trim()
            .toLowerCase()
            .split(/\s*,\s*/);
        for (const name of fields) {
            if (req.headers.get(name) !== this.#reqHeaders?.get(name)) return false;
        }
        return true;
    }

    #copyWithoutHopByHopHeaders(inHeaders: Headers) {
        const headers: Record<string, string> = {};
        inHeaders.forEach((value, name) => {
            if (hopByHopHeaders[name]) return;
            headers[name] = value;
        });
        // 9.1.  Connection
        if (inHeaders.has('connection')) {
            const tokens = inHeaders.get('connection')!.trim().split(/\s*,\s*/);
            for (const name of tokens) {
                delete headers[name];
            }
        }
        if (headers.warning) {
            const warnings = headers.warning.split(/,/).filter(warning => {
                return !/^\s*1[0-9][0-9]/.test(warning);
            });
            if (!warnings.length) {
                delete headers.warning;
            } else {
                headers.warning = warnings.join(',').trim();
            }
        }
        return headers;
    }

    responseHeaders() {
        const headers = this.#copyWithoutHopByHopHeaders(this.#resHeaders);
        const age = this.age();

        // A cache SHOULD generate 113 warning if it heuristically chose a freshness
        // lifetime greater than 24 hours and the response's age is greater than 24 hours.
        if (
            age > 3600 * 24 &&
            !this.#hasExplicitExpiration() &&
            this.maxAge() > 3600 * 24
        ) {
            headers.warning =
                (headers.warning ? `${headers.warning}, ` : '') +
                '113 - "rfc7234 5.5.4"';
        }
        headers.age = `${Math.round(age)}`;
        headers.date = new Date(this.now()).toUTCString();
        return headers;
    }

    /**
     * Value of the Date response header or current time if Date was invalid
     * @return timestamp
     */
    date() {
        const serverDate = Date.parse(this.#resHeaders.get('date') ?? '');
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

        const residentTime = (this.now() - this.#responseTime) / 1000;
        return age + residentTime;
    }

    #ageValue() {
        return toNumberOrZero(this.#resHeaders.get('age') ?? '');
    }

    /**
     * Possibly outdated value of applicable max-age (or heuristic equivalent) in seconds.
     * This counts since response's `Date`.
     *
     * For an up-to-date value, see `timeToLive()`.
     */
    maxAge() {
        if (!this.storable() || this.#resCacheControl['no-cache']) {
            return 0;
        }

        // Shared responses with cookies are cacheable according to the RFC, but IMHO it'd be unwise to do so by default
        // so this implementation requires explicit opt-in via public header
        if (
            this.#isShared &&
            (this.#resHeaders.has('set-cookie') &&
                !this.#resCacheControl.public &&
                !this.#resCacheControl.immutable)
        ) {
            return 0;
        }

        if (this.#resHeaders.get('vary') === '*') {
            return 0;
        }

        if (this.#isShared) {
            if (this.#resCacheControl['proxy-revalidate']) {
                return 0;
            }
            // if a response includes the s-maxage directive, a shared cache recipient MUST ignore the Expires field.
            if (this.#resCacheControl['s-maxage']) {
                return toNumberOrZero(this.#resCacheControl['s-maxage'] as string);
            }
        }

        // If a response includes a Cache-Control field with the max-age directive, a recipient MUST ignore the Expires field.
        if (this.#resCacheControl['max-age']) {
            return toNumberOrZero(this.#resCacheControl['max-age'] as string);
        }

        const defaultMinTtl = this.#resCacheControl.immutable ? this.#immutableMinTtl : 0;

        const serverDate = this.date();
        if (this.#resHeaders.has('expires')) {
            const expires = Date.parse(this.#resHeaders.get('expires')!);
            // A cache recipient MUST interpret invalid date formats, especially the value "0", as representing a time in the past (i.e., "already expired").
            if (Number.isNaN(expires) || expires < serverDate) {
                return 0;
            }
            return Math.max(defaultMinTtl, (expires - serverDate) / 1000);
        }

        if (this.#resHeaders.has('last-modified')) {
            const lastModified = Date.parse(this.#resHeaders.get('last-modified')!);
            if (isFinite(lastModified) && serverDate > lastModified) {
                return Math.max(
                    defaultMinTtl,
                    ((serverDate - lastModified) / 1000) * this.#cacheHeuristic
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
        const staleIfErrorAge = age + toNumberOrZero(this.#resCacheControl['stale-if-error'] as string);
        const staleWhileRevalidateAge = age + toNumberOrZero(this.#resCacheControl['stale-while-revalidate'] as string);
        return Math.round(Math.max(0, age, staleIfErrorAge, staleWhileRevalidateAge) * 1000);
    }

    stale() {
        return this.maxAge() <= this.age();
    }

    _useStaleIfError() {
        return this.maxAge() + toNumberOrZero(this.#resCacheControl['stale-if-error'] as string) > this.age();
    }

    useStaleWhileRevalidate() {
        return this.maxAge() + toNumberOrZero(this.#resCacheControl['stale-while-revalidate'] as string) > this.age();
    }

    static fromObject(obj: any) {
        // @ts-ignore
        return new this(undefined, undefined, { _fromObject: obj });
    }

    #fromObject(obj: any) {
        if (this.#responseTime) throw Error('Reinitialized');
        if (!obj || obj.v !== 1) throw Error('Invalid serialization');

        this.#responseTime = obj.t;
        this.#isShared = obj.sh;
        this.#cacheHeuristic = obj.ch;
        this.#immutableMinTtl =
            obj.imm !== undefined ? obj.imm : 24 * 3600 * 1000;
        this.#status = obj.st;
        this.#resHeaders = obj.resh;
        this.#resCacheControl = obj.rescc;
        this.#method = obj.m;
        this.#url = obj.u;
        this.#host = obj.h;
        this.#noAuthorization = obj.a;
        this.#reqHeaders = obj.reqh;
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
            resh: this.#resHeaders,
            rescc: this.#resCacheControl,
            m: this.#method,
            u: this.#url,
            h: this.#host,
            a: this.#noAuthorization,
            reqh: this.#reqHeaders,
            reqcc: this.#reqCacheControl,
        };
    }

    /**
     * Headers for sending to the origin server to revalidate stale response.
     * Allows server to return 304 to allow reuse of the previous response.
     *
     * Hop by hop headers are always stripped.
     * Revalidation headers may be added or removed, depending on request.
     */
    revalidationHeaders(req: Request) {
        this.#assertRequestHasHeaders(req);
        const headers = this.#copyWithoutHopByHopHeaders(req.headers);

        // This implementation does not understand range requests
        delete headers['if-range'];

        if (!this.#requestMatches(req, true) || !this.storable()) {
            // revalidation allowed via HEAD
            // not for the same resource, or wasn't allowed to be cached anyway
            delete headers['if-none-match'];
            delete headers['if-modified-since'];
            return headers;
        }

        /* MUST send that entity-tag in any cache validation request (using If-Match or If-None-Match) if an entity-tag has been provided by the origin server. */
        if (this.#resHeaders.has('etag')) {
            headers['if-none-match'] = headers['if-none-match']
                ? `${headers['if-none-match']}, ${this.#resHeaders.get('etag')}`
                : this.#resHeaders.get('etag')!;
        }

        // Clients MAY issue simple (non-subrange) GET requests with either weak validators or strong validators. Clients MUST NOT use weak validators in other forms of request.
        const forbidsWeakValidators =
            headers['accept-ranges'] ||
            headers['if-match'] ||
            headers['if-unmodified-since'] ||
            (this.#method && this.#method != 'GET');

        /* SHOULD send the Last-Modified value in non-subrange cache validation requests (using If-Modified-Since) if only a Last-Modified value has been provided by the origin server.
        Note: This implementation does not understand partial responses (206) */
        if (forbidsWeakValidators) {
            delete headers['if-modified-since'];

            if (headers['if-none-match']) {
                const etags = headers['if-none-match']
                    .split(/,/)
                    .filter(etag => {
                        return !/^\s*W\//.test(etag);
                    });
                if (!etags.length) {
                    delete headers['if-none-match'];
                } else {
                    headers['if-none-match'] = etags.join(',').trim();
                }
            }
        } else if (
            this.#resHeaders.get('last-modified') &&
            !headers['if-modified-since']
        ) {
            headers['if-modified-since'] = this.#resHeaders.get('last-modified')!;
        }

        return headers;
    }

    /**
     * Creates new CachePolicy with information combined from the previews response,
     * and the new revalidation response.
     *
     * Returns {policy, modified} where modified is a boolean indicating
     * whether the response body has been modified, and old cached body can't be used.
     *
     * @return {Object} {policy: CachePolicy, modified: Boolean}
     */
    revalidatedPolicy(request: Request, response: Response) {
        this.#assertRequestHasHeaders(request);
        if(this._useStaleIfError() && isErrorResponse(response)) {  // I consider the revalidation request unsuccessful
          return {
            modified: false,
            matches: false,
            policy: this,
          };
        }
        if (!response || !response.headers) {
            throw Error('Response headers missing');
        }

        // These aren't going to be supported exactly, since one CachePolicy object
        // doesn't know about all the other cached objects.
        let matches = false;
        if (response.status !== undefined && response.status != 304) {
            matches = false;
        } else if (
            response.headers.has('etag') &&
            !/^\s*W\//.test(response.headers.get('etag')!)
        ) {
            // "All of the stored responses with the same strong validator are selected.
            // If none of the stored responses contain the same strong validator,
            // then the cache MUST NOT use the new response to update any stored responses."
            matches =
                this.#resHeaders.has('etag') &&
                this.#resHeaders.get('etag')!.replace(/^\s*W\//, '') ===
                    response.headers.get('etag');
        } else if (this.#resHeaders.has('etag') && response.headers.has('etag')) {
            // "If the new response contains a weak validator and that validator corresponds
            // to one of the cache's stored responses,
            // then the most recent of those matching stored responses is selected for update."
            matches =
                this.#resHeaders.get('etag')!.replace(/^\s*W\//, '') ===
                response.headers.get('etag')!.replace(/^\s*W\//, '');
        } else if (this.#resHeaders.has('last-modified')) {
            matches =
                this.#resHeaders.get('last-modified') ===
                response.headers.get('last-modified');
        } else {
            // If the new response does not include any form of validator (such as in the case where
            // a client generates an If-Modified-Since request from a source other than the Last-Modified
            // response header field), and there is only one stored response, and that stored response also
            // lacks a validator, then that stored response is selected for update.
            if (
                !this.#resHeaders.has('etag') &&
                !this.#resHeaders.has('last-modified') &&
                !response.headers.has('etag') &&
                !response.headers.has('last-modified')
            ) {
                matches = true;
            }
        }

        if (!matches) {
            return {
                // @ts-ignore
                policy: new this.constructor(request, response),
                // Client receiving 304 without body, even if it's invalid/mismatched has no option
                // but to reuse a cached body. We don't have a good way to tell clients to do
                // error recovery in such case.
                modified: response.status != 304,
                matches: false,
            };
        }

        // use other header fields provided in the 304 (Not Modified) response to replace all instances
        // of the corresponding header fields in the stored response.
        const headers: Record<string, string | null> = {};
        for (const k in this.#resHeaders) {
            headers[k] =
                k in response.headers && !excludedFromRevalidationUpdate[k]
                    ? response.headers.get(k)
                    : this.#resHeaders.get(k);
        }

        const newResponse = Object.assign({}, response, {
            status: this.#status,
            method: this.#method,
            headers,
        });
        return {
            // @ts-ignore
            policy: new this.constructor(request, newResponse, {
                shared: this.#isShared,
                cacheHeuristic: this.#cacheHeuristic,
                immutableMinTimeToLive: this.#immutableMinTtl,
            }),
            modified: false,
            matches: true,
        };
    }
};