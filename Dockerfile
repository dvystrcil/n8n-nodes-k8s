# Node-only image for n8n's N8N_CUSTOM_EXTENSIONS (homelab#1961 AC10).
#
# Not an n8n image: it holds the built package and its production
# dependencies, and copies them into a directory at start. In Kubernetes an
# init container runs it against an emptyDir that the stock n8n container
# mounts and points N8N_CUSTOM_EXTENSIONS at.
#
# Layout (what n8n 2.x's CustomDirectoryLoader scans for):
#   /n8n-custom/node_modules/@dvystrcil/n8n-nodes-k8s/package.json   ("n8n" field)
#   /n8n-custom/node_modules/@dvystrcil/n8n-nodes-k8s/dist/...
#   /n8n-custom/node_modules/@dvystrcil/n8n-nodes-k8s/node_modules/... (prod deps only)

ARG NODE_IMAGE=node:26.12.1-alpine
ARG BASE_IMAGE=busybox:1.37.0-musl

FROM ${NODE_IMAGE} AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

# Mutation test, for CI only (`docker build --target mutation`): on the ARC
# runner the job container is small (1 CPU / 512Mi) but builds run in its
# Docker-in-Docker sidecar, which has room for Stryker. Never part of the
# release image (the last stage below is).
FROM ${NODE_IMAGE} AS mutation
RUN apk add --no-cache openssl
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json stryker.config.json deps-baseline.json ./
COPY scripts ./scripts
COPY src ./src
COPY test ./test
RUN npx stryker run 2>&1 | tee /tmp/mutation.out; grep -q 'is greater than or equal to break threshold' /tmp/mutation.out

FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /pkg
COPY package.json package-lock.json ./
# No install scripts run (the dependency gate also fails on any that exist).
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY --from=build /src/dist ./dist
COPY deps-baseline.json ./
COPY scripts/audit-deps.mjs ./scripts/
# Audit exactly the tree being shipped, inside the build.
RUN node scripts/audit-deps.mjs --root /pkg | tee /tmp/audit.out && grep -qx DEPS-AUDIT-OK /tmp/audit.out \
 && rm -rf scripts deps-baseline.json

FROM ${BASE_IMAGE}
COPY --from=prod-deps --chown=1000:1000 /pkg /n8n-custom/node_modules/@dvystrcil/n8n-nodes-k8s
USER 1000:1000
# Copy into the target directory (the emptyDir), then confirm the node file
# landed. Default target /custom.
ENTRYPOINT ["sh", "-c", "set -e; dest=\"${1:-/custom}\"; cp -R /n8n-custom/. \"$dest\"/; test -s \"$dest\"/node_modules/@dvystrcil/n8n-nodes-k8s/dist/nodes/KubernetesBatch/KubernetesBatch.node.js; echo \"n8n-nodes-k8s copied to $dest\"", "copy"]
