ARG BASE_IMAGE
ARG TOOLCHAIN_IMAGE

FROM ${TOOLCHAIN_IMAGE} AS dsh-builder

ENV PNPM_HOME=/pnpm \
    PNPM_STORE_DIR=/pnpm/store \
    npm_config_store_dir=/pnpm/store \
    PATH=/pnpm:${PATH}

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ARG HOST_PACKAGE_MANAGER
RUN corepack enable && corepack prepare "$HOST_PACKAGE_MANAGER" --activate

WORKDIR /app/deepseek-harness
COPY --from=harness-source harness-source.tar /tmp/harness-source.tar
RUN tar -xf /tmp/harness-source.tar -C /app/deepseek-harness \
    && rm /tmp/harness-source.tar \
    && pnpm fetch --frozen-lockfile
ARG DSH_COMMIT_SHA
RUN test -n "$DSH_COMMIT_SHA" \
    && pnpm install --offline --frozen-lockfile \
    && DSH_CLIENT_COMMIT_HASH="$DSH_COMMIT_SHA" pnpm run build

# pnpm's injected deploy resolves this reviewed workspace postinstall to its
# absolute builder path. Approve that exact artifact in the disposable builder
# copy, then produce a production-only closure whose links stay self-contained.
RUN relative_allow='@deepseek-ai/dsh-subprocess-local@file:packages/subprocess/subprocess-local' \
    && absolute_allow='@deepseek-ai/dsh-subprocess-local@file:///app/deepseek-harness/packages/subprocess/subprocess-local' \
    && grep -Fq "$relative_allow" pnpm-workspace.yaml \
    && sed -i "s|$relative_allow|$absolute_allow|" pnpm-workspace.yaml \
    && npm pkg set --prefix python/sdk-runtime \
        'dependencies.@deepseek-ai/dsh-session-title-llm=workspace:^' \
        'dependencies.@deepseek-ai/dsh-util-workspace-path=workspace:^' \
    && pnpm install --lockfile-only --no-frozen-lockfile \
    && pnpm --filter dsh-python-runtime-closure deploy \
        --prod \
        --config.inject-workspace-packages=true \
        --no-frozen-lockfile \
        --offline \
        --store-dir "$PNPM_STORE_DIR" \
        /opt/dsh-runtime \
    && while IFS= read -r -d '' link; do \
        target="$(readlink -f "$link")"; \
        case "$target" in \
            /opt/dsh-runtime/*) ;; \
            *) echo "运行时闭包包含外部链接：$link -> $target" >&2; exit 1 ;; \
        esac; \
    done < <(find /opt/dsh-runtime -type l -print0) \
    && for package in dsh-session-title-llm dsh-util-workspace-path; do \
        test -f "/opt/dsh-runtime/node_modules/@deepseek-ai/${package}/package.json" \
            || { echo "运行时闭包缺少 @deepseek-ai/${package}。" >&2; exit 1; }; \
    done \
    && node /opt/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js --version

FROM ${TOOLCHAIN_IMAGE} AS manager-builder
WORKDIR /app/plugin-manager
COPY --from=manager-source / /app/plugin-manager/
# Local source deployments and this isolated builder share the same preparation.
RUN node scripts/manager-tooling.mjs --root /app/plugin-manager --archive /tmp/plugin-manager.tgz

FROM ${BASE_IMAGE} AS dsh-runtime

ARG DSH_COMMIT_SHA
ARG DSH_VERSION
ARG DSH_RECIPE_HASH
LABEL org.opencontainers.image.revision=${DSH_COMMIT_SHA} \
      org.opencontainers.image.version=${DSH_VERSION} \
      com.deepseek-plugin.dsh.runtime-recipe=${DSH_RECIPE_HASH}

COPY --from=dsh-builder /opt/dsh-runtime /opt/dsh-runtime
COPY --from=dsh-builder /opt/runtime-corepack /opt/runtime-corepack
COPY --from=manager-builder /tmp/plugin-manager.tgz /tmp/plugin-manager.tgz
RUN npm install --prefix /opt/plugin-manager --offline --omit=dev --ignore-scripts --no-audit --no-fund /tmp/plugin-manager.tgz \
    && rm /tmp/plugin-manager.tgz \
    && mkdir -p /opt/plugin-project
ARG PLUGIN_PNPM_VERSION
RUN ln -s "/opt/runtime-corepack/v1/pnpm/${PLUGIN_PNPM_VERSION}/bin/pnpm.mjs" /usr/local/bin/pnpm \
    && test "$(pnpm --version)" = "$PLUGIN_PNPM_VERSION" \
    && test "$(node /opt/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js --version)" = "$DSH_VERSION" \
    && install -d -o node -g node /data/dsh-home /data/workspace

ENV NODE_ENV=production \
    DSH_HOST_SOURCE_SHA=${DSH_COMMIT_SHA} \
    COREPACK_HOME=/opt/runtime-corepack \
    COREPACK_ENABLE_NETWORK=0 \
    DSH_DATA_DIR=/data \
    DSH_HOME=/data/dsh-home \
    DSH_WORKSPACE=/data/workspace \
    DSH_AUTH_URL_FILE=/data/dsh-web-auth-url.txt \
    DSH_STORE_DIR=/data/plugin-store \
    DSH_PORT=7902 \
    DSH_CLI_JS=/opt/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js \
    PLUGIN_MANIFEST_FILE=/opt/plugin-packages/manifest.json
USER node
WORKDIR /data/workspace
EXPOSE 7902
ENTRYPOINT ["node", "/opt/plugin-manager/node_modules/@dsh-plugin-manager/plugin-manager/dist/cli.mjs", "container-start", "--root", "/opt/plugin-project"]
