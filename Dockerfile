# Use a lightweight Node.js image https://hub.docker.com/_/node 
# crack: pinned by digest — node:24-alpine as of 2026-11-02.
FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85

# Set working directory
WORKDIR /src

# Set environment variables
ENV NODE_ENV="production"

# Copy package*.json and .env dependencies
COPY package*.json ./
COPY .env.template ./.env

# Install necessary system packages
RUN apk add --no-cache bash vim

# Install Node.js dependencies (fail the build immediately if install fails,
# so a broken arm64 image is never published)
# crack: --ignore-scripts — no dependency code runs during the build; npm ci
# checks every package against its integrity hash in package-lock.json.
RUN npm ci --omit=dev --ignore-scripts --silent \
    && npm cache clean --force \
    && rm -rf /tmp/* /var/tmp/* /usr/share/doc/*

# Copy the application code, already owned by the runtime user
COPY --chown=node:node app app
COPY --chown=node:node public public

# crack: third-party browser files (vendor/sources.txt), downloaded and checked
# by sha256; the pages load them from this node instead of CDNs. check fails
# the build if a page still loads anything from a third-party host.
COPY vendor vendor
RUN node vendor/vendor.mjs check && node vendor/vendor.mjs fetch

# Rename config.template.js to config.js
COPY --chown=node:node ./app/src/config.template.js ./app/src/config.js

# Run as the non-root "node" user (uid/gid 1000) shipped with the base image
USER node

# Set default command to start the application
CMD ["npm", "start"]