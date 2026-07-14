FROM golang:1.22-bookworm AS build
WORKDIR /src
COPY go.mod go.sum* ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/chopper ./cmd/server

FROM python:3.11-slim-bookworm

# Bakes demucs in, which is what gives you stem separation. It pulls torch, so
# the image grows by roughly two gigabytes. Set to 0 at build time if you want
# a small image and no stem splitting.
ARG WITH_DEMUCS=1

RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir yt-dlp \
    && if [ "$WITH_DEMUCS" = "1" ]; then pip install --no-cache-dir demucs; fi

WORKDIR /app
COPY --from=build /out/chopper /app/chopper

# No ENV ADDR and no EXPOSE on purpose. The listen port is random per deployment
# and comes from .env through compose, so anything baked in here would only ever
# be a stale lie. If ADDR is unset the server falls back to :8080.
ENV DATA_DIR=/data
VOLUME ["/data"]

ENTRYPOINT ["/app/chopper"]
