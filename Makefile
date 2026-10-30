# =============================================================================
# ai-field-dev-assessment — convenience entry points
#
#   make install     install all workspace dependencies from the lockfile (npm ci)
#   make verify      hygiene + doc-path guard + typecheck + offline tests (what a grader runs)
#   make test        offline tests only
#   make live        opt-in tests that call the local OpenAI-compatible server
#   make demo-1..4   runnable end-to-end demos (see each task README)
# =============================================================================

SHELL := /bin/bash
NPM   := npm

.PHONY: help install verify typecheck test hygiene live \
        demo-1 demo-2 demo-3 demo-4 clean

help:
	@grep -E '^#( |$$)' $(MAKEFILE_LIST) | sed 's/^# \{0,1\}//'

install:
	$(NPM) ci

verify:
	$(NPM) run verify

typecheck:
	$(NPM) run typecheck

test:
	$(NPM) test

hygiene:
	$(NPM) run hygiene

live:
	RUN_LIVE_LLM=1 $(NPM) run test:live

demo-1:
	$(NPM) --workspace task-01-mcp-server run demo

demo-2:
	$(NPM) --workspace task-02-mcp-gateway run demo

demo-3:
	$(NPM) --workspace task-03-streaming-guardrail run demo

demo-4:
	$(NPM) --workspace task-04-router-fallback run demo

clean:
	$(NPM) run clean
