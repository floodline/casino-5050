FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
# /data must be a Coolify persistent-storage mount (SQLite file lives there).
ENV DB_PATH=/data/raffle.db
RUN mkdir -p /data && chown node:node /data
COPY --chown=node:node package.json server.js app.html ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null 2>&1 || exit 1
CMD ["node", "--no-warnings=ExperimentalWarning", "server.js"]
