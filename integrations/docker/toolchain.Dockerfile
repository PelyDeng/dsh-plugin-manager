ARG BASE_IMAGE
FROM ${BASE_IMAGE}

ARG DEBIAN_MIRROR=http://deb.debian.org
ARG HOST_PACKAGE_MANAGER
ARG PLUGIN_PACKAGE_MANAGER
ENV COREPACK_HOME=/opt/build-corepack

RUN sed -i "s|http://deb.debian.org|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable \
    && corepack prepare "$HOST_PACKAGE_MANAGER" \
    && corepack prepare "$PLUGIN_PACKAGE_MANAGER" --activate \
    && COREPACK_HOME=/opt/runtime-corepack corepack prepare "$PLUGIN_PACKAGE_MANAGER"

ENV COREPACK_ENABLE_NETWORK=0
