# ADR 0004: TypeScript executed directly by Node 22

Date: 2026-09-05. Status: accepted.

## Context

The model is a small, dependency-free library that renderers in several
stacks will consume. It needs types, tests, and a typecheck, and it needs
to run with as little ceremony as possible so that the first pixel in any
demo is minutes away.

## Decision

Source is TypeScript. Node 22 runs it directly with type stripping, so
there is no build step for the library or its tests. `tsc --noEmit` is the
typecheck. `node:test` is the test runner. The `erasableSyntaxOnly`
compiler option guarantees the source stays within what type stripping
supports: no enums, no parameter properties, no namespaces.

Demos that need a bundler use Vite in their own workspace and import the
library source directly.

## Consequences

- Zero build tooling in the library. `npm test` and `npm run typecheck` are
  the whole loop.
- Imports use explicit `.ts` extensions.
- Some TypeScript features are off limits by construction; the compiler
  flags them.
- If the library is ever published to npm, a `tsc` emit step is added at
  that point, not before.
