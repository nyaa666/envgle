# Fixture Dockerfile for envgle integration tests. Never built.
FROM node:20-alpine AS deps
ARG NODE_VERSION=20
ENV NODE_ENV=production
ENV PORT=3000 APP_NAME=api
WORKDIR /app
COPY package.json ./
RUN npm ci --omit=dev && echo "built $APP_NAME on node ${NODE_VERSION}"
