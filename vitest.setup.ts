import '@testing-library/jest-dom/vitest'

/**
 * jsdom implements no `IntersectionObserver`, and framer-motion's `whileInView` (used by the
 * `Stagger`/`FadeIn` helpers in `components/ui/animate.tsx`) constructs one on mount — an
 * unhandled `ReferenceError` that would fail any test rendering an animated view. This stub
 * reports every observed element as immediately in view, which is the state a test wants: the
 * content is present and assertable rather than parked at `opacity: 0`.
 */
if (typeof globalThis.IntersectionObserver === 'undefined') {
  class TestIntersectionObserver implements IntersectionObserver {
    readonly root: Element | Document | null = null
    readonly rootMargin: string = '0px'
    readonly thresholds: ReadonlyArray<number> = [0]

    private readonly callback: IntersectionObserverCallback

    constructor(callback: IntersectionObserverCallback) {
      this.callback = callback
    }

    observe(target: Element): void {
      this.callback(
        [
          {
            target,
            isIntersecting: true,
            intersectionRatio: 1,
            boundingClientRect: target.getBoundingClientRect(),
            intersectionRect: target.getBoundingClientRect(),
            rootBounds: null,
            time: 0,
          } as IntersectionObserverEntry,
        ],
        this
      )
    }

    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): IntersectionObserverEntry[] {
      return []
    }
  }

  globalThis.IntersectionObserver =
    TestIntersectionObserver as unknown as typeof IntersectionObserver
}
