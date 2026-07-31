import { fileURLToPath } from "node:url";
import js from "@eslint/js";
import globals from "globals";
import importPlugin from "eslint-plugin-import";
import vitest from "@vitest/eslint-plugin";
import tseslint from "typescript-eslint";

const tsconfigPath = "./tsconfig.eslint.json";
const tsconfigRootDir = fileURLToPath(new URL(".", import.meta.url));

const typeCheckedConfigs = tseslint.configs.recommendedTypeChecked.map(
  (config) => ({
    ...config,
    files: ["**/*.ts"],
  }),
);

const stylisticConfigs = tseslint.configs.stylisticTypeChecked.map(
  (config) => ({
    ...config,
    files: ["**/*.ts"],
  }),
);

export default tseslint.config(
  {
    ignores: [
      "dist/",
      "node_modules/",
      "coverage/",
      "**/*.d.ts",
      "**/tsconfig*.json",
    ],
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    ...js.configs.recommended,
    languageOptions: {
      sourceType: "module",
      ecmaVersion: "latest",
      globals: {
        ...globals.node,
      },
    },
  },
  ...typeCheckedConfigs,
  ...stylisticConfigs,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: tsconfigPath,
        tsconfigRootDir,
        sourceType: "module",
        ecmaVersion: "latest",
      },
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      import: importPlugin,
    },
    settings: {
      "import/resolver": {
        typescript: {
          project: tsconfigPath,
        },
      },
    },
    rules: {
      ...importPlugin.configs.recommended.rules,
      ...importPlugin.configs.typescript.rules,
      "import/extensions": ["error", "ignorePackages", { ts: "never" }],
      "import/no-extraneous-dependencies": [
        "error",
        {
          devDependencies: [
            "**/*.test.ts",
            "test/**/*.ts",
            "vitest.config.ts",
            "eslint.config.js",
          ],
        },
      ],
      // import/order 2.32.0 crashes on ESLint 10: its fixer calls
      // sourceCode.getTokenOrCommentBefore, removed in ESLint 10. Any
      // out-of-order import aborts the run instead of reporting. Re-enable
      // when eslint-plugin-import ships ESLint 10 support.
      "import/order": "off",
      "class-methods-use-this": "off",
      "no-console": "off",
      "no-await-in-loop": "off",
      "no-restricted-syntax": "off",
      "key-spacing": ["error", { beforeColon: false, afterColon: true }],
      "no-multi-spaces": [
        "error",
        {
          exceptions: {
            VariableDeclarator: true,
            PropertyAssignment: true,
            AssignmentExpression: true,
          },
        },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "warn",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["**/*.test.ts", "test/**/*.ts"],
    plugins: {
      vitest,
    },
    languageOptions: {
      globals: vitest.environments.env.globals,
    },
    rules: {
      ...vitest.configs.recommended.rules,
    },
  },
  {
    files: ["eslint.config.js", "vitest.config.ts", "tsconfig*.json"],
    languageOptions: {
      parserOptions: {
        sourceType: "module",
        ecmaVersion: "latest",
      },
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "import/no-extraneous-dependencies": "off",
    },
  },
);
