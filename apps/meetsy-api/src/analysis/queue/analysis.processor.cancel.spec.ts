import { CancelledRunError } from "./analysis.processor";

/**
 * v2 SSE progress-polish — the sentinel error the processor throws between
 * stages when `cancelRequestedAt` is set on the row. Caught by `process()`
 * to distinguish a deliberate user cancel (row → `status=cancelled`,
 * job NOT rethrown so BullMQ marks it completed) from a real pipeline
 * failure (row → `status=failed`, rethrown so BullMQ records the failure).
 *
 * This is the only invariant that MUST be locked with a test — if a
 * refactor renames the class, the `instanceof CancelledRunError` check in
 * the outer catch silently degrades to the failure branch, and users
 * cancelling a run would see it as a red-banner error instead of a clean
 * "Cancelled" state.
 */
describe("CancelledRunError", () => {
  it("is a real Error subclass so `throw` semantics work", () => {
    const err = new CancelledRunError();
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(CancelledRunError);
  });

  it("has the stable `name` used by the outer catch's branch check", () => {
    // The catch uses `err instanceof CancelledRunError`, but the `name` is
    // also read by log formatting — keep both correct in one assertion.
    expect(new CancelledRunError().name).toBe("CancelledRunError");
  });

  it("defaults to the user-facing 'Cancelled by user' message", () => {
    expect(new CancelledRunError().message).toBe("Cancelled by user");
  });

  it("accepts a custom message when a caller wants context", () => {
    expect(new CancelledRunError("stopped mid-critic").message).toBe("stopped mid-critic");
  });
});
