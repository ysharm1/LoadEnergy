import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

/**
 * DOM test setup for the `ui` project.
 *
 * Unmounts anything a test rendered so the next test starts from an empty
 * document instead of inheriting the previous one's markup.
 */
afterEach(() => {
  cleanup();
});
