import tseslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

const testFiles = ["src/**/*.test.ts", "src/tests/**/*.ts"];
const cliFiles = [
  "src/index.ts",
  "src/**/*cli.ts",
  "src/**/*-cli.ts",
  "src/channels/cli/**/*.ts",
  "src/intelligence/strada-api-sync.ts",
];
const operationalConsoleFiles = [
  "src/alerting/**/*.ts",
  "src/backup/**/*.ts",
  "src/channels/web/channel.ts",
  "src/core/setup-wizard.ts",
];

export default [
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      "no-console": "warn",
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-floating-promises": "off",
    },
  },
  {
    files: testFiles,
    rules: {
      "no-console": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  {
    files: cliFiles,
    rules: {
      "no-console": "off",
    },
  },
  {
    files: operationalConsoleFiles,
    rules: {
      "no-console": "off",
    },
  },
  {
    ignores: [
      "dist/",
      "node_modules/",
      "*.config.js",
      "*.config.ts",
      "src/channels/web/static/*.js",
    ],
  },
];
