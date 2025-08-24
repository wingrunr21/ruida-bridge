# use the official Bun Alpine image for smaller size
# see all versions at https://hub.docker.com/r/oven/bun/tags
FROM oven/bun:1-alpine AS base
WORKDIR /usr/src/app

# install dependencies into temp directory
# this will cache them and speed up future builds
FROM base AS install
RUN mkdir -p /temp/dev
COPY package.json bun.lock /temp/dev/
RUN cd /temp/dev && bun install --frozen-lockfile

# install with --production (exclude devDependencies)
RUN mkdir -p /temp/prod
COPY package.json bun.lock /temp/prod/
RUN cd /temp/prod && bun install --frozen-lockfile --production

# copy node_modules from temp directory
# then copy all (non-ignored) project files into the image
FROM base AS prerelease
COPY --from=install /temp/dev/node_modules node_modules
COPY . .

# [optional] tests & build
ENV NODE_ENV=production
# Skip tests for now as they're not implemented yet
# RUN bun test
RUN bun run build

# copy production dependencies and source code into final image
FROM base AS release
COPY --from=install /temp/prod/node_modules node_modules
COPY --from=prerelease /usr/src/app/index.ts .
COPY --from=prerelease /usr/src/app/src/ ./src/
COPY --from=prerelease /usr/src/app/package.json .
COPY --from=prerelease /usr/src/app/tsconfig.json .

# Install curl for healthchecks (Alpine uses apk)
RUN apk add --no-cache curl

# run the app
USER bun
# TCP port for client connections
EXPOSE 5005/tcp
# UDP ports for laser communication
EXPOSE 40200/udp 50200/udp
# Status endpoint
EXPOSE 3000/tcp
ENV LASER_IP=10.0.3.3
ENV BRIDGE_PORT=5005
ENV PORT=3000
ENTRYPOINT [ "bun", "run", "index.ts" ]
