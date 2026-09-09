FROM node:20-alpine

# tini as PID 1, and a plain `node dist/index.js` default CMD instead of the
# dev/hot-reload wrapper — see the matching, more detailed comments in
# client-api/Dockerfile. worker has no shutdown handler of its own today,
# but gets the same treatment for consistency, and so Ctrl+C during a plain
# `docker run` behaves sanely too.
RUN apk add --no-cache tini

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

RUN npm run build

EXPOSE 3001

ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/index.js"]
