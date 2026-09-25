# Build from repository root: docker build -f server/Dockerfile -t opencluely-managed .
FROM node:22.14.0-bookworm-slim
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && mkdir /data && chown node:node /data
COPY server/*.js ./
COPY prompt-loader.js /app/prompt-loader.js
COPY prompts /app/prompts
USER node
ENV NODE_ENV=production PORT=8080 DATABASE_PATH=/data/managed.sqlite
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:8080/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "index.js"]
