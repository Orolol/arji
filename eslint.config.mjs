import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

import noBareJsxCopy from "./eslint-rules/no-bare-jsx-copy.mjs";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_"
        }
      ]
    }
  },
  {
    // Playwright fixtures hand their value to a callback named `use`, which
    // the React hooks rule reads as a hook called outside a component. No file
    // under e2e/ renders React at all, so the rule has nothing to check here.
    files: ["e2e/**"],
    rules: {
      "react-hooks/rules-of-hooks": "off",
    },
  },
  {
    files: ["components/**/*.tsx", "app/**/*.tsx"],
    ignores: ["app/piscine-preview/**", "app/_piscine-preview/**"],
    plugins: { i18n: { rules: { "no-bare-jsx-copy": noBareJsxCopy } } },
    rules: {
      "i18n/no-bare-jsx-copy": ["error", { allowPattern: "^(?:(?:·|—|→|←|↑|↓|⌘|⌥|⇧|…)+|git remote (?:add|set-url)(?: --push)?|<url>)$" }],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Agent worktrees and runtime data contain independent or historical
    // source trees; lint this checkout, as the Vitest exclude list does.
    ".claude/**",
    "projects/**",
    "data/**",
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
