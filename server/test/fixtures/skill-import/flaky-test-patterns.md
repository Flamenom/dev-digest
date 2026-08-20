---
name: flaky-test-patterns
description: Flag test changes that introduce time-, order-, or randomness-dependent behavior; every pattern here has made a suite red on someone else's machine.
---

# Flaky test patterns

Review changed test files for constructs that make a suite pass locally and
fail in CI. Every pattern below is a defect in the test, not the code under
test — report it against the exact test lines in the diff.

## Timing

- **Real-clock sleeps** — `await new Promise(r => setTimeout(r, 500))` before an
  assertion. The right duration does not exist: too short flakes, too long slows
  the suite. Use fake timers, or poll for the condition with a deadline.
- **Arbitrary timeouts as synchronization** — raising a test timeout to "fix" a
  race hides it. The awaited operation should expose a completion signal.
- **Wall-clock assertions** — expecting `Date.now()`-derived values (created_at,
  expiry) to match within an implicit window. Inject or freeze the clock.

## Ordering and shared state

- **Inter-test coupling** — a test that only passes after another test ran
  (shared module state, leftover rows, singleton caches). Each test must build
  its own world; reset state in a hook, not in a previous test.
- **Parallelism assumptions** — asserting on a global (env var, tmp file, port)
  that a concurrently running test also touches.

## Non-determinism

- **Unseeded randomness** — `Math.random()`-generated fixtures without a fixed
  seed; a failure can never be reproduced.
- **Iteration-order assumptions** — asserting on object-key or Set iteration
  order, or on DB rows without an ORDER BY.
- **Unawaited async work** — assertions that race a floating promise; the test
  passes when the promise loses the race and fails when it wins.

Severity: WARNING when the pattern can plausibly flake in CI; SUGGESTION for
hygiene (seedable randomness, clock injection) when the test is otherwise
deterministic. In each finding name the pattern and the deterministic
replacement.
