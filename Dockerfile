FROM node:20-alpine
WORKDIR /app
COPY package.json index.mjs ./
RUN chmod +x index.mjs
# Zero runtime dependencies; stdio MCP server.
ENTRYPOINT ["node", "index.mjs"]
