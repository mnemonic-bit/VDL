# Keep tag names beside immutable indexes so monthly refreshes remain readable.
FROM docker.io/denoland/deno:bin-2.9.5@sha256:0d1262facd139e815217c001945eb822c7a78584cf660142c34a6b53effec1aa AS deno
FROM docker.io/library/python:3.14-slim@sha256:cad9a2c871761c413caa6fdd6441c783451e740a48aaeba60ae62a8b53525ef6

ARG VDL_UID=10001
ARG VDL_GID=10001

ENV DOWNLOADS_DIR=/downloads \
    DOWNLOADS_DB=/data/downloads.db \
    VDL_INGEST_DIR=/ingest \
    HOST=0.0.0.0 \
    PORT=5000 \
    FLASK_DEBUG=0 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DENO_NO_UPDATE_CHECK=1 \
    DENO_NO_PROMPT=1 \
    DENO_DIR=/home/vdl/.cache/deno \
    XDG_CACHE_HOME=/home/vdl/.cache

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        ffmpeg \
        tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid "${VDL_GID}" vdl \
    && useradd --uid "${VDL_UID}" --gid vdl --create-home --home-dir /home/vdl vdl \
    && install -d -o vdl -g vdl /data /downloads /ingest /home/vdl/.cache/deno

COPY --from=deno /deno /usr/local/bin/deno

WORKDIR /app

COPY requirements-container.in requirements-container.constraints requirements-container.txt ./
RUN python -m pip install --no-cache-dir --require-hashes -r requirements-container.txt

# Runtime source is deliberately allow-listed instead of copying the repository.
COPY vdl.py docker-entrypoint.sh VERSION ./
COPY templates/ templates/
COPY static/ static/
RUN chmod 0555 /app/docker-entrypoint.sh \
    && chmod -R a-w /app

VOLUME ["/downloads", "/data", "/ingest"]
EXPOSE 5000

USER 10001:10001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import json, os, urllib.request; response = urllib.request.urlopen('http://127.0.0.1:' + os.environ.get('PORT', '5000') + '/api/health', timeout=3); assert response.status == 200 and json.load(response).get('ok') is True"

ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker-entrypoint.sh"]
CMD ["python", "vdl.py"]
