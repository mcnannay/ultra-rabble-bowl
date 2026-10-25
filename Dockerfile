FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends espeak-ng ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --chown=node:node server.js index.html ./
RUN mkdir -p /app/cache/headshots /app/cache/uniforms /app/cache/voice && chown -R node:node /app/cache
USER node
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0 NO_BROWSER=1
EXPOSE 3000
VOLUME ["/app/cache"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD node -e "require('http').get('http://127.0.0.1:3000/',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "server.js"]
