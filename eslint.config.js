import tseslint from "typescript-eslint";
export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "worker-configuration.d.ts",
      "data/generated/**",
      "data/raw/**",
      ".alchemy/**",
      ".wrangler/**",
    ],
  },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["eslint.config.js", "commitlint.config.js"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
);
