# Fixture Dockerfile for envgle integration tests. Never built.
FROM golang:1.22 AS build
ARG VERSION=dev
ENV CGO_ENABLED=0 GOOS=linux
ARG SOME_ARG
WORKDIR /src
RUN go build -ldflags "-X main.version=${VERSION}" -o /out/service . && echo "arg=${SOME_ARG:-d}"

FROM gcr.io/distroless/static-debian12
ENV APP_NAME=go-service PORT=8080
# Legacy ENV form with a variable in the value: this rewrites the image PATH.
ENV PATH /usr/local/bin:$PATH
COPY --from=build /out/service /usr/local/bin/service
ENTRYPOINT ["/usr/local/bin/service"]
