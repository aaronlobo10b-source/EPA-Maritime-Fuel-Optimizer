FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    PORT=10000 \
    PYTHON_EXECUTABLE=/opt/fuelcast-env/bin/python

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@12.3.4 --activate

WORKDIR /app
COPY . .

RUN pnpm install --frozen-lockfile \
    && python3 -m venv /opt/fuelcast-env \
    && /opt/fuelcast-env/bin/pip install --no-cache-dir -r scripts/requirements-fuelcast.txt \
    && pnpm run typecheck:libs \
    && PORT=10000 BASE_PATH=/ pnpm --filter @workspace/maritime-optimizer run build \
    && pnpm --filter @workspace/api-server run build

EXPOSE 10000
CMD ["pnpm", "--filter", "@workspace/api-server", "run", "start"]
