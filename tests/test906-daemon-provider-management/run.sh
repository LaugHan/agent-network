#!/bin/sh
set -eu
bun test agent-network/src/daemon-provider-store.test.ts
bun test agent-network/src/private-state.test.ts
bun test agent-network/src/daemon-provider-application.test.ts
bun test agent-network/src/codex-copresence-rpc.test.ts
