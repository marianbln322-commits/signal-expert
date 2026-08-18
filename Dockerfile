FROM node:22-alpine AS build
WORKDIR /source
COPY . .
RUN node scripts/build.mjs

FROM node:22-alpine
WORKDIR /app
ENV API_HOST=0.0.0.0 API_PORT=4100 DATABASE_PATH=/app/data/signal-expert.db PUBLIC_DIRECTORY=/app/public MIGRATION_DIRECTORY=/app/migrations
COPY --from=build /source/dist/ ./
RUN mkdir -p /app/data
VOLUME ["/app/data"]
EXPOSE 4100
HEALTHCHECK --interval=10s --timeout=5s --retries=10 CMD wget -q -O - http://localhost:4100/health || exit 1
CMD ["node", "app/server.mjs"]
