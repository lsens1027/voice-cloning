FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY index.html styles.css app.js manifest.json sw.js icon.svg server.mjs README.md ./
ENV NODE_ENV=production
ENV PORT=4173
EXPOSE 4173
CMD ["node", "server.mjs"]
