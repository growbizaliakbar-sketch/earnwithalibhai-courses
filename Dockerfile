FROM node:24-slim

# Non-root user for production
RUN groupadd -r appuser && useradd -r -g appuser appuser

WORKDIR /app

# Install deps first (better layer caching)
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY src ./src
COPY views ./views
COPY public ./public
COPY .env.example ./

# Runtime dirs (persist via volumes)
RUN mkdir -p /app/data /app/uploads/videos /app/uploads/thumbs \
 && chown -R appuser:appuser /app

VOLUME ["/app/data", "/app/uploads"]

USER appuser

EXPOSE 3000
ENV NODE_ENV=production
ENV PORT=3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/healthz').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"

CMD ["node", "src/server.js"]
