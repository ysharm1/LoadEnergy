import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/** `@/...` resolves to `src/...`, matching tsconfig's path mapping. */
const alias = {
  "@": fileURLToPath(new URL("./src", import.meta.url)),
};

/**
 * Vitest's transformer has to emit React elements itself: `tsconfig.json`
 * keeps `jsx: "preserve"` for Next's own compiler, which Vitest cannot run.
 *
 * Vite 8 (Vitest 4) transforms with Oxc rather than esbuild, so this is the
 * `oxc` option; the old `esbuild.jsx` shorthand is no longer read.
 */
const jsx = { jsx: { runtime: "automatic", importSource: "react" } } as const;

/**
 * Two projects, because the suites need different globals:
 *
 * - `services` — the domain, service, repository, and HTTP layers. Pure
 *   TypeScript over an injected repository, so a Node environment is both
 *   enough and fastest for the property tests' 100+ iterations.
 * - `ui` — the PWA shell and the field screens, which need a DOM to render
 *   into (Requirements 15.1–15.3).
 *
 * Both share `test/setup.ts` so the project-wide fast-check floor of 100 runs
 * applies wherever a property test lives.
 */
export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        oxc: jsx,
        test: {
          name: "services",
          globals: true,
          environment: "node",
          include: ["src/**/*.test.ts", "test/**/*.test.ts"],
          setupFiles: ["./test/setup.ts"],
        },
      },
      {
        resolve: { alias },
        oxc: jsx,
        test: {
          name: "ui",
          globals: true,
          environment: "jsdom",
          include: ["app/**/*.test.ts", "app/**/*.test.tsx"],
          setupFiles: ["./test/setup.ts", "./test/setup-dom.ts"],
        },
      },
    ],
  },
});
