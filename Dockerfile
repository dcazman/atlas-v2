FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src
COPY skills.json ./skills.json

ENV PORT=7784
EXPOSE 7784

VOLUME ["/app/data"]

CMD ["node", "src/server.js"]
