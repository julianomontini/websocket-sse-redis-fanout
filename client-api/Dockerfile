FROM node:20-alpine

# tini as PID 1 — general good practice for signal handling / zombie
# reaping in any container. See the CMD note below for the *actual* fix to
# the specific SIGTERM problem this project cares about.
RUN apk add --no-cache tini

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# Pre-build for the CMD below. Irrelevant when docker-compose overrides the
# command to the dev/hot-reload one (see docker-compose.yml) — src/ is
# bind-mounted over this anyway in that case.
RUN npm run build

EXPOSE 3000

ENTRYPOINT ["tini", "--"]

# Default command: run the plain compiled output directly with `node`.
# This is what docker-compose.replicas.yml actually runs (no command
# override), and it's *load-bearing* for graceful shutdown, not just a
# style choice: `ts-node-dev --respawn` (the dev/hot-reload command,
# selected instead by docker-compose.yml) manages the real script as a
# child process of its own, and does not wait for that child to finish
# handling SIGTERM before exiting itself — confirmed by hand, it kills the
# whole process tree mid-drain, right after src/index.ts's handler logs
# that SIGTERM was received. Plain `node dist/index.js` has no such wrapper:
# it *is* the process our SIGTERM handler runs in, so there's nothing to
# race against.
CMD ["node", "dist/index.js"]
