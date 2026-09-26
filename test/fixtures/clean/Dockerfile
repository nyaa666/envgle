# Fixture Dockerfile for envgle integration tests. Never built.
FROM node:20-alpine
ENV APP_NAME=example-web PORT=3000 LOG_LEVEL=info
ENV BACKEND_URL=https://api.example.com FEATURE_FLAGS=checkout,search REQUEST_TIMEOUT_MS=5000
WORKDIR /app
COPY src ./src
CMD ["node", "src/app.js"]
