import fc from "fast-check";

/**
 * Global fast-check configuration.
 *
 * design.md ("Testing Strategy") requires every correctness property to run a
 * minimum of 100 iterations. Setting it globally here makes 100 the floor for
 * every property test; an individual test may still pass a higher `numRuns`.
 */
fc.configureGlobal({ numRuns: 100 });
