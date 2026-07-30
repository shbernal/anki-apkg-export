import js from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import parser from "@typescript-eslint/parser";
import globals from "globals";

export default [
  {
    ignores: ["dist", "node_modules", "coverage"],
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser,
      parserOptions: {
        sourceType: "module",
      },
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      "@typescript-eslint/explicit-function-return-type": "off",
    },
  },
  {
    files: ["test/**/*.{ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
    },
  },
];
