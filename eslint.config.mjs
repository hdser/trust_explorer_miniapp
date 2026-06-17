import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "public/cosmos-gl-browser.min.js",
  ]),
  {
    rules: {
      // Resetting loading state synchronously before a fetch-on-mount is intentional here.
      "react-hooks/set-state-in-effect": "warn",
      // The cosmos.gl wrapper is an imperative WebGL integration: it must hold the graph
      // instance in a ref and mutate it. These React Compiler rules don't fit that.
      "react-hooks/refs": "off",
      "react-hooks/immutability": "off",
    },
  },
]);

export default eslintConfig;
