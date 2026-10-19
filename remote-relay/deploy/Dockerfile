FROM node:22-bookworm-slim
ENV NODE_ENV=production RELAY_BIND=0.0.0.0 PORT=8788 RELAY_DATA_DIR=/data
WORKDIR /app
RUN mkdir /data && chown node:node /data
COPY server.cjs ./server.cjs
COPY licenses ./licenses
USER node
EXPOSE 8788
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:8788/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server.cjs"]
