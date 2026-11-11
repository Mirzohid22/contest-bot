# syntax=docker/dockerfile:1

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY web/package.json web/package-lock.json web/
RUN npm ci --prefix web
COPY . .
RUN npm run build \
 && npm run build --prefix web \
 && npm prune --omit=dev

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/dist dist
COPY --from=build /app/web/dist web/dist
COPY --from=build /app/migrations migrations
COPY package.json ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "--max-old-space-size=512", "dist/main.js"]
