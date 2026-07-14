FROM golang:1.22-bookworm AS build
WORKDIR /src
COPY go.mod go.sum* ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/chopper ./cmd/server

FROM python:3.11-slim-bookworm

# Set to 1 at build time to bake demucs in. It pulls torch, so the image grows
# by roughly two gigabytes. Leave it off unless you actually want stem splitting.
ARG WITH_DEMUCS=0

RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir yt-dlp \
    && if [ "$WITH_DEMUCS" = "1" ]; then pip install --no-cache-dir demucs; fi

WORKDIR /app
COPY --from=build /out/chopper /app/chopper

ENV ADDR=:8080
ENV DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8080

ENTRYPOINT ["/app/chopper"]
