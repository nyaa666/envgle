# Fixture Dockerfile for envgle integration tests. Never built.
FROM composer:2.7 AS vendor
WORKDIR /app
COPY . .
RUN composer install --no-dev --no-scripts --no-interaction

FROM php:8.3-fpm
ENV APP_ENV=production APP_DEBUG=false LOG_LEVEL=warning
WORKDIR /app
COPY --from=vendor /app /app
EXPOSE 8000
CMD ["php", "artisan", "serve", "--host=0.0.0.0", "--port=8000"]
