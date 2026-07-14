FROM golang:1.22-bookworm AS build
WORKDIR /src
# go.sum is committed and not optional. Without it, go build under the default
# -mod=readonly fails with "missing go.sum entry", because go mod download only
# records go.mod hashes and not module content hashes. Copy it explicitly so a
# missing one fails loudly here rather than confusingly three lines down.
COPY go.mod go.sum ./
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

RUN pip install --no-cache-dir yt-dlp

# demucs does not list numpy as a dependency, and torch treats it as optional,
# so a plain "pip install demucs" gives you a torch that cannot initialise numpy
# and a demucs that dies on import. Install it explicitly. Pinned under 2.0
# because the torch and torchaudio wheels are built against the 1.x ABI.
#
# The model weights are pulled at build time too. Otherwise the first stem split
# quietly stalls for a few minutes downloading a few hundred megabytes, which
# looks exactly like a hang.
ENV TORCH_HOME=/opt/torch
RUN if [ "$WITH_DEMUCS" = "1" ]; then \
        pip install --no-cache-dir "numpy<2" demucs \
        && python -c "from demucs.pretrained import get_model; get_model('htdemucs')" \
        && python -c "import numpy, torch; torch.zeros(1).numpy(); print('numpy ok', numpy.__version__)" ; \
    fi

WORKDIR /app
COPY --from=build /out/chopper /app/chopper

# No ENV ADDR and no EXPOSE on purpose. The listen port is random per deployment
# and comes from .env through compose, so anything baked in here would only ever
# be a stale lie. If ADDR is unset the server falls back to :8080.
ENV DATA_DIR=/data
VOLUME ["/data"]

ENTRYPOINT ["/app/chopper"]
