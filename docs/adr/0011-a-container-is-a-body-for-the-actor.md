# ADR 0011: A container is a body for the actor, not a new contract

Date: 2026-09-06. Status: accepted.

## Context

Oscar asked whether a bit could be a data store connected to a Docker
container. Half of it already held: a bit keeps small data in its
passport and large data by content id in a `Storage` (ADR 0010), and a
bit's work runs through the `ActorPool` contract in process, in the
browser, or on a durable engine (Phases 12, 13, 15). What was missing was
a container as the place the work runs.

## Decision

- **The container runs the existing worker.** `docker/worker.Dockerfile`
  packages `scripts/durable-worker.ts` unchanged over a scene folder
  mounted at `/scene`, with the engine's address in an environment
  variable. No new contract, no new backend class: the container is a
  body for `DurableActorPool`'s worker side, and the workflow ids and the
  idempotent record steps of Phase 15 are what make a killed container's
  job finish once on the next one.
- **The host helper drives Docker, nothing else.** `scripts/docker-host.ts`
  builds the image, runs the engine's dev server as a container on a
  private network, starts and kills worker containers, and stops them. It
  is the only file that knows Docker exists.
- **The container talks to the scene the way an agent does.** It writes
  through the model's own API inside the worker; anything outside it
  reaches the scene through the MCP server. No side door.
- **The oracle is Phase 15's, run through Docker.** Sixty-four jobs on a
  worker container with one record per step, then a container killed
  with SIGKILL mid-job and a second finishing it exactly once. The test
  opts in with `VPB_DOCKER=1`, because building the image takes minutes
  and CI runners vary; the journal records the numbers where it ran.

## Consequences

- A bit now has three bodies for work (a process, a browser, a
  container) and one for light (the strip, or its twin), all writing one
  history.
- The image carries the repository's runtime dependencies including the
  engine's native bridge; it is built from the repository root and is not
  published anywhere.
- Data in a container is not the bit's data. The bit's data is what the
  ledger and the storage hold; a container is disposable by design, and
  the kill test is the proof.
