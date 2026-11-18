# One Dockerfile for every service:  docker build --build-arg SERVICE=game -t ipm-game .
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
COPY services ./services
RUN npm ci --omit=dev

FROM node:22-alpine
ARG SERVICE
ENV NODE_ENV=production SERVICE=${SERVICE}
WORKDIR /app
COPY --from=deps /app ./
USER node
CMD ["sh", "-c", "node services/${SERVICE}/src/index.js"]
