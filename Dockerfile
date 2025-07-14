# use the official Bun image
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
RUN bun run build

# copy production dependencies and source code into final image
FROM base AS release
WORKDIR /app
COPY --from=prerelease /usr/src/app/server.js .
COPY --from=prerelease /usr/src/app/public/ ./public
ENV NODE_ENV=production

# Install wget and set up permissions
RUN apk add --no-cache wget && \
  mkdir -p data && \
  chown -R bun:bun /app && \
  chmod 755 /app

USER bun
EXPOSE 3000/tcp
ENTRYPOINT [ "bun", "run", "server.js" ]