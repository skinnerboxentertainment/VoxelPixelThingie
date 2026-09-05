# Contributing

This repository is run by a small ritual. Follow it and your change merges
quickly; skip a step and CI or a reviewer will send it back.

## Before you start

Open an issue from the Ticket template. It asks for four things: objective,
non-goals, assumptions, and an **oracle**, the cheap executable check that
will show the work is done. If no cheap oracle exists, building one is the
first task. The `oracle-missing` label stays on until the oracle is written,
and no branch is cut while it is there.

## Branch and commit

- Branch from `main` as `type/short-name`. Types: `feat`, `fix`, `chore`,
  `docs`, `test`, `perf`, `refactor`, `ci`, `build`.
- Commits follow [Conventional Commits](https://www.conventionalcommits.org/).
  A commit-msg hook enforces it.
- A pre-commit hook formats and lints staged files with Biome.

## Run locally

```
npm ci
npm run typecheck
npm run lint
npm test
npm run test:coverage
```

CI runs exactly these. If they pass here, they pass there.

## Before opening a PR

Run the review pass in this order and record the results in the PR body:

1. `/intent-check`: the diff does only what the issue said.
2. `/roast`: adversarial read. Fix what bites first.
3. `/code-review`: correctness.
4. `claim-auditor` on the PR description. Every checkable sentence is
   probed against the diff or marked Trusted.

Collect findings and fix once at the settled head. If two consecutive rounds
find the same shape of defect, shrink the surface instead of patching again.

## Pull request

- Title is a Conventional Commit; it becomes the squash commit message.
- Fill the template. The oracle result at the head SHA is required.
- CI must be green. `main` is protected: no direct pushes, squash merge only.
- Close the issue with one line: "oracle passed at `<sha>`."

## Writing

Comments state constraints, not conclusions. Commit messages and PR bodies
describe the diff, not the intent behind it. Counts and labels are measured
or removed.

## Decisions

Anything that changes SPEC.md or the shape of the public API gets an ADR in
`docs/adr/`, numbered, in context / decision / consequences form.
