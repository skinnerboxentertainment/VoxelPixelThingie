export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "type-enum": [
      2,
      "always",
      ["feat", "fix", "chore", "docs", "test", "perf", "refactor", "ci", "build", "revert"],
    ],
    "body-max-line-length": [0],
    "footer-max-line-length": [0],
  },
};
