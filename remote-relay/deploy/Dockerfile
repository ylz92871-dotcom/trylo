FROM node:22.23.4-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da
ENV NODE_ENV=production RELAY_BIND=0.0.0.0 PORT=8788 RELAY_DATA_DIR=/data
WORKDIR /app
RUN mkdir /data && chown node:node /data
COPY server.cjs ./server.cjs
COPY admin-account.cjs ./admin-account.cjs
COPY model-admin.cjs ./model-admin.cjs
COPY security-admin.cjs ./security-admin.cjs
COPY web ./web
COPY licenses ./licenses
# The release helper extracts with umask 077. Public build assets need explicit
# traversal/read modes for node; private /data is deliberately outside scope.
RUN find /app/web /app/licenses -type d -exec chmod 0755 {} + \
 && find /app/web /app/licenses -type f -exec chmod 0644 {} +
USER node
EXPOSE 8788
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:8788/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server.cjs"]
