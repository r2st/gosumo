import '@testing-library/jest-dom/vitest';

// jsdom implements no layout, so `Element.prototype.scrollTo` does not exist —
// not as a stub, not as a throwing not-implemented shim. Any component that
// scrolls a container into place from an effect (chat threads, message lists)
// therefore crashes on mount under test, with a TypeError from inside React's
// effect flush that reads as a component bug rather than an environment gap.
//
// Stubbed here rather than per file so the next such component does not have to
// rediscover it. Guarded, so a future jsdom that implements it wins.
if (!Element.prototype.scrollTo) {
  Element.prototype.scrollTo = () => {};
}
