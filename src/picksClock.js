// Server clock for lock and grade. Tests replace it. A client cannot.
let nowFn = () => Date.now();

export function picksNow() {
    const value = nowFn();
    return value instanceof Date ? value.getTime() : Number(value);
}

export function setPicksNowForTests(fn) {
    nowFn = typeof fn === 'function' ? fn : (() => Date.now());
}
