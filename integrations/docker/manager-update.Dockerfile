ARG RUNTIME_IMAGE
FROM ${RUNTIME_IMAGE}
USER root
ARG MANAGER_SHA256
ARG FRAMEWORK_REVISION
LABEL com.dsh-plugin-manager.manager.sha256=${MANAGER_SHA256} \
      com.dsh-plugin-manager.framework.revision=${FRAMEWORK_REVISION}
COPY plugin-manager.tgz /tmp/plugin-manager.tgz
RUN test -n "$MANAGER_SHA256" \
    && echo "$MANAGER_SHA256  /tmp/plugin-manager.tgz" | sha256sum -c - \
    && rm -rf /opt/plugin-manager \
    && npm install --prefix /opt/plugin-manager --offline --omit=dev --ignore-scripts --no-audit --no-fund /tmp/plugin-manager.tgz \
    && rm /tmp/plugin-manager.tgz \
    && node /opt/plugin-manager/node_modules/@dsh-plugin-manager/plugin-manager/dist/cli.mjs --help
USER node
ENTRYPOINT ["node", "/opt/plugin-manager/node_modules/@dsh-plugin-manager/plugin-manager/dist/cli.mjs", "container-start", "--root", "/opt/plugin-project"]
