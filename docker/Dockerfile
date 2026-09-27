FROM node:25.8.1-bookworm-slim@sha256:44bcbf493408a824104e74976ae5539f596c46cbe75ed0423a137552a555e2de
COPY codex /usr/local/bin/codex
COPY relay.mjs codex-profile.json /opt/workshop/
USER 65532:65532
ENTRYPOINT ["node", "/opt/workshop/relay.mjs"]
