# Fixture Dockerfile for envgle integration tests. Never built.
FROM python:3.12-slim AS builder
ARG POETRY_VERSION=1.8.3
# Legacy ENV form: the name and the value are two arguments, no equals sign.
ENV POETRY_HOME /opt/poetry
ENV POETRY_VIRTUALENVS_CREATE false
WORKDIR /build
RUN pip install --no-cache-dir "poetry==${POETRY_VERSION}"

FROM python:3.12-slim AS runtime
ENV APP_HOME=/app PYTHONUNBUFFERED=1
WORKDIR /app
COPY --from=builder /opt/poetry /opt/poetry
COPY . .
EXPOSE 8000
CMD ["gunicorn", "app.main:app", "--bind", "0.0.0.0:8000"]
