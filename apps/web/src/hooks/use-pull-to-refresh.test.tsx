/**
 * `use-pull-to-refresh.tsx` — the mobile pull-to-refresh gesture.
 *
 * This is the one hook in the directory that is not a React Query wrapper, and
 * the only one whose behaviour is invisible under a default jsdom run: it
 * short-circuits on `isTouchDevice()`, so without stubbing touch support every
 * listener path is dead code and a test suite would report green over a gesture
 * that never fires. The suite stubs `navigator.maxTouchPoints` and drives real
 * touch events at a real element.
 *
 * What the gesture has to get right, and what a user sees when it does not:
 *
 *  - **Only from the very top.** A pull that starts mid-list, or one where the
 *    finger crosses back into the list, must abandon — otherwise scrolling
 *    down a long conversation triggers a refresh that scrolls it back to the
 *    top.
 *  - **`preventDefault` on the downward drag.** Without it the browser's own
 *    overscroll bounce runs underneath the indicator, and the page rubber-bands
 *    while the spinner is trying to hold still.
 *  - **A threshold, and resistance.** The pull travels at half the finger's
 *    speed and arms only past 64px, so a slightly sloppy scroll does not fire a
 *    refresh. Past the cap the indicator stops following the finger entirely.
 *  - **The reset always runs.** `finally` — a refresh whose callback rejects
 *    must still clear `isRefreshing`, or the spinner stays up forever and the
 *    gesture is permanently dead (a new pull is refused while refreshing).
 */

import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PullToRefreshIndicator, usePullToRefresh } from './use-pull-to-refresh';

const THRESHOLD = 64;
const MAX_PULL = 96;
/** Finger travel that lands exactly on the threshold, given 0.5 resistance. */
const ARMING_DRAG = THRESHOLD * 2;

/**
 * A touch event carrying one point. jsdom does not construct `TouchEvent`, and
 * the hook only reads `touches[0].clientY`, so a plain Event with the shape
 * attached is both sufficient and honest about what the code depends on.
 */
function touchEvent(type: string, clientY: number): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', { value: [{ clientY }] });
  return event;
}

function Harness({ onRefresh }: { onRefresh: () => void | Promise<unknown> }) {
  const { containerRef, pullDistance, isRefreshing } = usePullToRefresh<HTMLDivElement>(onRefresh);
  return (
    <div
      ref={containerRef}
      data-testid="container"
      data-pull={pullDistance}
      data-refreshing={String(isRefreshing)}
    >
      <PullToRefreshIndicator pullDistance={pullDistance} isRefreshing={isRefreshing} />
    </div>
  );
}

/** Render the harness and return the container plus readers for its state. */
function setup(onRefresh: () => void | Promise<unknown> = vi.fn()) {
  const view = render(<Harness onRefresh={onRefresh} />);
  const el = view.getByTestId('container');
  return {
    ...view,
    el,
    pull: () => Number(el.dataset.pull),
    refreshing: () => el.dataset.refreshing === 'true',
    /** Pretend the container is scrolled down by `px`. */
    scrollTo(px: number) {
      Object.defineProperty(el, 'scrollTop', { value: px, configurable: true });
    },
    async fire(type: string, clientY = 0) {
      let event!: Event;
      await act(async () => {
        event = touchEvent(type, clientY);
        el.dispatchEvent(event);
      });
      return event;
    },
  };
}

/** Drag from y=0 down to `to`, without releasing. */
async function drag(s: ReturnType<typeof setup>, to: number) {
  await s.fire('touchstart', 0);
  await s.fire('touchmove', to);
}

/**
 * Model a touch or pointer-only device.
 *
 * `isTouchDevice()` checks `'ontouchstart' in window || navigator.maxTouchPoints > 0`,
 * and jsdom defines `ontouchstart` on `window` whatever it is pretending to be
 * — so the desktop case needs the property genuinely removed, not just set
 * falsy. Without that, every "inert on desktop" assertion would pass for the
 * wrong reason.
 */
function setTouchSupport(enabled: boolean) {
  const win = window as unknown as Record<string, unknown>;
  if (enabled) win.ontouchstart = null;
  else delete win.ontouchstart;

  Object.defineProperty(window.navigator, 'maxTouchPoints', {
    value: enabled ? 5 : 0,
    configurable: true,
  });
}

beforeEach(() => setTouchSupport(true));
afterEach(() => setTouchSupport(false));

it('the harness really can model a pointer-only browser', () => {
  // Guards the guard: if jsdom ever stops letting `ontouchstart` be deleted,
  // the desktop tests below would silently start running the touch path.
  setTouchSupport(false);
  expect('ontouchstart' in window).toBe(false);
  expect(navigator.maxTouchPoints).toBe(0);
});

// ─────────────────────────────────────────────
// Device gating
// ─────────────────────────────────────────────

describe('the gesture exists only where a finger does', () => {
  it('attaches nothing on a desktop browser', async () => {
    // On a pointer device the listeners are never bound, so a synthetic touch
    // event — or a stray one from a hybrid laptop — cannot trigger a refresh.
    setTouchSupport(false);
    const onRefresh = vi.fn();
    const s = setup(onRefresh);

    await drag(s, ARMING_DRAG);
    await s.fire('touchend');

    expect(onRefresh).not.toHaveBeenCalled();
    expect(s.pull()).toBe(0);
  });

  it('binds the listeners on a touch device', async () => {
    const onRefresh = vi.fn();
    const s = setup(onRefresh);

    await drag(s, ARMING_DRAG);
    await s.fire('touchend');

    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('unbinds them on unmount', async () => {
    // The listeners sit on a DOM node React is about to discard. Leaving them
    // bound keeps the whole hook closure — and the container — alive.
    const s = setup();
    const remove = vi.spyOn(s.el, 'removeEventListener');

    s.unmount();

    expect(remove.mock.calls.map((c) => c[0]).sort()).toEqual([
      'touchcancel',
      'touchend',
      'touchmove',
      'touchstart',
    ]);
  });
});

// ─────────────────────────────────────────────
// The pull
// ─────────────────────────────────────────────

describe('the pull tracks the finger at half speed', () => {
  it('applies resistance, so the drag feels heavier than it travels', async () => {
    // 0.5 resistance: the indicator moves half as far as the finger. Without it
    // the sheet leaps out from under a small movement.
    const s = setup();

    await drag(s, 40);

    expect(s.pull()).toBe(20);
  });

  it('caps the visible pull so the indicator never runs away', async () => {
    // A long swipe would otherwise push the spinner off the bottom of the
    // container.
    const s = setup();

    await drag(s, 1000);

    expect(s.pull()).toBe(MAX_PULL);
  });

  it('ignores an upward drag', async () => {
    // Fingers wander. A drag that ends above where it started is not a pull.
    const s = setup();

    await s.fire('touchstart', 100);
    await s.fire('touchmove', 60);

    expect(s.pull()).toBe(0);
  });

  it('suppresses the browser’s native overscroll while pulling down', async () => {
    // Without preventDefault the page rubber-bands underneath the indicator.
    const s = setup();

    await s.fire('touchstart', 0);
    const move = await s.fire('touchmove', 40);

    expect(move.defaultPrevented).toBe(true);
  });

  it('leaves an upward drag to the browser', async () => {
    // Nothing is being pulled, so the native scroll must still work.
    const s = setup();

    await s.fire('touchstart', 100);
    const move = await s.fire('touchmove', 60);

    expect(move.defaultPrevented).toBe(false);
  });

  it('ignores a move that never started with a touchstart', async () => {
    // Touch sequences can arrive partial after a cancelled gesture.
    const s = setup();

    await s.fire('touchmove', 200);

    expect(s.pull()).toBe(0);
  });
});

describe('the pull only starts at the very top of the list', () => {
  it('does not begin while the container is scrolled down', async () => {
    // Otherwise dragging down through a long thread refreshes it and jumps the
    // reader back to the top.
    const onRefresh = vi.fn();
    const s = setup(onRefresh);
    s.scrollTo(120);

    await drag(s, ARMING_DRAG);
    await s.fire('touchend');

    expect(s.pull()).toBe(0);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('abandons a pull the moment the finger scrolls into the list', async () => {
    // Momentum can carry the container down mid-gesture. The pull is dropped
    // rather than left armed.
    const onRefresh = vi.fn();
    const s = setup(onRefresh);

    await drag(s, ARMING_DRAG);
    expect(s.pull()).toBe(THRESHOLD);

    s.scrollTo(50);
    await s.fire('touchmove', ARMING_DRAG + 40);
    await s.fire('touchend');

    expect(s.pull()).toBe(0);
    expect(onRefresh).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// Release
// ─────────────────────────────────────────────

describe('release fires a refresh only past the threshold', () => {
  it('snaps back without refreshing on a short pull', async () => {
    // A slightly sloppy scroll should not cost a network round trip.
    const onRefresh = vi.fn();
    const s = setup(onRefresh);

    await drag(s, THRESHOLD); // 32px of pull — half the threshold
    await s.fire('touchend');

    expect(onRefresh).not.toHaveBeenCalled();
    expect(s.pull()).toBe(0);
  });

  it('fires exactly at the threshold', async () => {
    const onRefresh = vi.fn();
    const s = setup(onRefresh);

    await drag(s, ARMING_DRAG);
    await s.fire('touchend');

    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('treats a cancelled touch like a release', async () => {
    // The OS cancels the sequence when a call arrives or the app backgrounds.
    // Without this handler the gesture would be left mid-pull, with the
    // indicator stuck open and `pullingRef` never cleared.
    const onRefresh = vi.fn();
    const s = setup(onRefresh);

    await drag(s, ARMING_DRAG);
    await s.fire('touchcancel');

    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(s.pull()).toBe(0);
  });

  it('ignores a release that follows no pull', async () => {
    const onRefresh = vi.fn();
    const s = setup(onRefresh);

    await s.fire('touchend');

    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('holds the spinner at the threshold while the refresh runs', async () => {
    // The pull is pinned rather than released so the spinner has somewhere to
    // sit — otherwise it collapses to zero height mid-request.
    let release!: () => void;
    const onRefresh = vi.fn(() => new Promise<void>((r) => (release = r)));
    const s = setup(onRefresh);

    await drag(s, 1000); // pulled well past the cap
    await s.fire('touchend');

    expect(s.refreshing()).toBe(true);
    expect(s.pull()).toBe(THRESHOLD);

    await act(async () => release());

    expect(s.refreshing()).toBe(false);
    expect(s.pull()).toBe(0);
  });

  it('refuses a new pull while one is already in flight', async () => {
    // Two overlapping refreshes would race, and the second `finally` would
    // clear the spinner while the first was still running.
    let release!: () => void;
    const onRefresh = vi.fn(() => new Promise<void>((r) => (release = r)));
    const s = setup(onRefresh);

    await drag(s, ARMING_DRAG);
    await s.fire('touchend');
    expect(s.refreshing()).toBe(true);

    await drag(s, ARMING_DRAG);
    await s.fire('touchend');

    expect(onRefresh).toHaveBeenCalledTimes(1);

    await act(async () => release());
  });

  it('clears the spinner even when the refresh throws', async () => {
    // Without the `finally`, a failed refetch leaves `isRefreshing` true — the
    // spinner never stops and every later pull is refused, so the gesture is
    // dead until the page is reloaded.
    const onRefresh = vi.fn().mockRejectedValue(new Error('503 Service Unavailable'));
    const s = setup(onRefresh);

    await drag(s, ARMING_DRAG);
    await s.fire('touchend');

    expect(s.refreshing()).toBe(false);
    expect(s.pull()).toBe(0);
  });

  it('absorbs the rejection instead of leaking an unhandled one', async () => {
    // `finish` is an async event listener, so nothing awaits its result: a
    // rejected `onRefresh` escapes the call stack entirely and surfaces as an
    // unhandled rejection — a console error on every failed pull, and a report
    // in whatever crash reporter the page is wired to.
    const unhandled = vi.fn();
    window.addEventListener('unhandledrejection', unhandled);

    const onRefresh = vi.fn().mockRejectedValue(new Error('503 Service Unavailable'));
    const s = setup(onRefresh);

    await drag(s, ARMING_DRAG);
    await s.fire('touchend');
    // Let any escaped rejection reach the microtask queue.
    await act(async () => {
      await Promise.resolve();
    });

    window.removeEventListener('unhandledrejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('accepts a fresh pull after a failed refresh', async () => {
    const onRefresh = vi.fn().mockRejectedValueOnce(new Error('503')).mockResolvedValueOnce(undefined);
    const s = setup(onRefresh);

    await drag(s, ARMING_DRAG);
    await s.fire('touchend');

    await drag(s, ARMING_DRAG);
    await s.fire('touchend');

    expect(onRefresh).toHaveBeenCalledTimes(2);
  });

  it('accepts a synchronous callback that returns nothing', async () => {
    // The signature allows `() => void`. Awaiting undefined is fine, but the
    // spinner must still resolve rather than hanging on a non-promise.
    const onRefresh = vi.fn(() => undefined);
    const s = setup(onRefresh);

    await drag(s, ARMING_DRAG);
    await s.fire('touchend');

    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(s.refreshing()).toBe(false);
  });

  it('calls the latest callback, not the one bound at mount', async () => {
    // The listeners bind once and read `onRefresh` through a ref. Without that
    // ref, a re-render with a new closure — the usual case, since callers pass
    // an inline arrow — would keep invoking the first render's stale one.
    const first = vi.fn();
    const second = vi.fn();
    const { rerender, ...s } = setup(first);

    rerender(<Harness onRefresh={second} />);
    await drag(s as ReturnType<typeof setup>, ARMING_DRAG);
    await (s as ReturnType<typeof setup>).fire('touchend');

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────
// The indicator
// ─────────────────────────────────────────────

describe('PullToRefreshIndicator', () => {
  it('renders nothing at rest', () => {
    // It sits inside a `position: relative` container as an absolutely
    // positioned overlay; rendering it at zero height would still intercept the
    // top of every list.
    const { container } = render(
      <PullToRefreshIndicator pullDistance={0} isRefreshing={false} />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('stays visible during a refresh even once the pull is released', () => {
    const { container } = render(
      <PullToRefreshIndicator pullDistance={0} isRefreshing={true} />,
    );

    expect(container).not.toBeEmptyDOMElement();
  });

  it('grows to exactly the pull distance', () => {
    const { container } = render(
      <PullToRefreshIndicator pullDistance={40} isRefreshing={false} />,
    );

    expect((container.firstElementChild as HTMLElement).style.height).toBe('40px');
  });

  it('rotates and fades in with the pull, so the arm point is visible', () => {
    // At half the threshold the arrow is part-turned and part-faded; the user
    // can tell they have not pulled far enough yet.
    const { container } = render(
      <PullToRefreshIndicator pullDistance={THRESHOLD / 2} isRefreshing={false} />,
    );
    const icon = container.querySelector('svg') as SVGElement;

    expect(icon.style.transform).toBe('rotate(135deg)');
    expect(icon.style.opacity).toBe('0.7');
  });

  it('reaches full rotation and opacity at the threshold', () => {
    const { container } = render(
      <PullToRefreshIndicator pullDistance={THRESHOLD} isRefreshing={false} />,
    );
    const icon = container.querySelector('svg') as SVGElement;

    expect(icon.style.transform).toBe('rotate(270deg)');
    expect(icon.style.opacity).toBe('1');
  });

  it('does not keep rotating past the threshold', () => {
    // Progress is clamped, so over-pulling looks the same as being armed —
    // which is the truth: pulling further changes nothing.
    const { container } = render(
      <PullToRefreshIndicator pullDistance={MAX_PULL} isRefreshing={false} />,
    );
    const icon = container.querySelector('svg') as SVGElement;

    expect(icon.style.transform).toBe('rotate(270deg)');
  });

  it('spins and drops the pull-time styling once refreshing', () => {
    // The static rotation is cleared so it cannot fight the spin animation.
    const { container } = render(
      <PullToRefreshIndicator pullDistance={THRESHOLD} isRefreshing={true} />,
    );
    const icon = container.querySelector('svg') as SVGElement;

    expect(icon.getAttribute('class')).toContain('animate-spin');
    expect(icon.style.transform).toBe('');
  });
});
