import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["dist/**", "node_modules/**", "functions/node_modules/**", "functions/shared/**", ".firebase/**"] },
  js.configs.recommended,
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: { ecmaVersion: 2024, sourceType: "module" },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none" }],
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-implicit-globals": "error",
      "prefer-const": "error",
    },
  },
  // Browser code
  { files: ["src/**/*.js", "public/**/*.js"], languageOptions: { globals: globals.browser } },
  // Shared code runs in both
  { files: ["shared/**/*.js"], languageOptions: { globals: { ...globals.browser, ...globals.node } } },
  // Server, scripts and tests
  {
    files: ["functions/**/*.js", "functions/**/*.mjs", "scripts/**/*.mjs", "tests/**/*.js", "*.config.js"],
    languageOptions: { globals: globals.node },
  },
];
