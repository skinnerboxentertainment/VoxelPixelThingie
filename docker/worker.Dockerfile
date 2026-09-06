# The durable worker as a container (ADR 0011): one more body for a scene's
# actors. Build from the repository root:
#   docker build -f docker/worker.Dockerfile -t vpb-worker .
# Run with the scene folder mounted at /scene and the engine's address:
#   docker run --rm --network vpb -v <folder>:/scene -e TEMPORAL_ADDRESS=temporal:7233 vpb-worker
FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY src ./src
COPY scripts ./scripts
COPY demo/shared ./demo/shared
ENV NODE_ENV=production
ENV TEMPORAL_ADDRESS=temporal:7233
ENV VPB_TASK_QUEUE=vpb-bits
ENTRYPOINT ["sh", "-c", "exec node --experimental-strip-types scripts/durable-worker.ts --scene /scene --address \"$TEMPORAL_ADDRESS\" --task-queue \"$VPB_TASK_QUEUE\""]
