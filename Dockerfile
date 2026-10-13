FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# No runtime dependencies: Node 22.18+ runs TypeScript (type stripping) and ships node:sqlite.
COPY package.json ./
COPY src ./src
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/health || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.ts"]
