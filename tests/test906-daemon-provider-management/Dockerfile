FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4
WORKDIR /work
COPY agent-network/src ./agent-network/src
COPY tests/test906-daemon-provider-management/run.sh /run.sh
RUN useradd --create-home --uid 10001 runner
USER runner
CMD ["sh", "/run.sh"]
