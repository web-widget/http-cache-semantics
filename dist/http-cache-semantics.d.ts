type CacheValue = {
    v: number;
    t: number;
    sh: boolean;
    ch: number;
    imm: number;
    st: number;
    resh: Record<string, string>;
    rescc: Record<string, string | boolean>;
    m: string;
    u: string;
    h: string | null;
    a: boolean;
    reqh: Record<string, string> | null;
    reqcc: Record<string, string | boolean>;
};
declare class CachePolicy {
    #private;
    constructor(req: Request, res: Response, { shared, cacheHeuristic, immutableMinTimeToLive, ignoreCargoCult, _fromObject, }?: {
        shared?: boolean;
        cacheHeuristic?: number;
        immutableMinTimeToLive?: number;
        ignoreCargoCult?: boolean;
        _fromObject?: CacheValue;
    });
    now(): number;
    storable(): boolean;
    satisfiesWithoutRevalidation(req: Request): boolean;
    responseHeaders(): Headers;
    /**
     * Value of the Date response header or current time if Date was invalid
     */
    date(): number;
    /**
     * Value of the Age header, in seconds, updated for the current time.
     * May be fractional.
     */
    age(): number;
    /**
     * Possibly outdated value of applicable max-age (or heuristic equivalent) in seconds.
     * This counts since response's `Date`.
     *
     * For an up-to-date value, see `timeToLive()`.
     */
    maxAge(): number;
    /**
     * Up-to-date `max-age` value, in *milliseconds*.
     *
     * Prefer this method over `maxAge()`.
     */
    timeToLive(): number;
    stale(): boolean;
    useStaleWhileRevalidate(): boolean;
    static fromObject(obj: CacheValue): CachePolicy;
    toObject(): CacheValue;
    /**
     * Headers for sending to the origin server to revalidate stale response.
     * Allows server to return 304 to allow reuse of the previous response.
     *
     * Hop by hop headers are always stripped.
     * Revalidation headers may be added or removed, depending on request.
     */
    revalidationHeaders(req: Request): Headers;
    /**
     * Creates new CachePolicy with information combined from the previews response,
     * and the new revalidation response.
     *
     * Returns {policy, modified} where modified is a boolean indicating
     * whether the response body has been modified, and old cached body can't be used.
     */
    revalidatedPolicy(request: Request, response: Response): {
        policy: CachePolicy;
        modified: boolean;
        matches: boolean;
    };
}

export { CachePolicy as default };
