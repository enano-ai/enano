PY := $(if $(wildcard .venv/bin/python),.venv/bin/python,python3)
WEB_PORT ?= 8599
VITE_PORT ?= 5173
DOC ?= dev/sample-goal-notes.txt
BUNDLE ?= $(HOME)/.enano/models/personal-goals/latest
QUERY ?=

.PHONY: install test release web-kill web-restart webapp webapp-dev webapp-dev-kill scan-raw clean \
	pull import list search models update upgrade use info rm prune verify scan walk watch \
	elevators elevations doctor web

# ---- build & development

install:
	python3 -m venv .venv
	.venv/bin/pip install -e ".[dev]"

test:
	$(PY) -m pytest tests/

release:
	$(PY) scripts/release.py $(ARGS)

web-kill:
	@pids=$$(lsof -ti tcp:$(WEB_PORT)); \
	if [ -n "$$pids" ]; then \
		echo "stopping pid(s) $$pids on :$(WEB_PORT)"; \
		kill $$pids; \
	else \
		echo "nothing running on :$(WEB_PORT)"; \
	fi

web-restart: web-kill
	@while lsof -ti tcp:$(WEB_PORT) >/dev/null 2>&1; do sleep 0.1; done
	$(PY) -m enano web $(ARGS)

webapp:
	cd webapp && npm install && npm run build

webapp-dev:
	cd webapp && npm run dev

webapp-dev-kill:
	@pids=$$(lsof -ti tcp:$(VITE_PORT)); \
	if [ -n "$$pids" ]; then \
		echo "stopping pid(s) $$pids on :$(VITE_PORT)"; \
		kill $$pids; \
	else \
		echo "nothing running on :$(VITE_PORT)"; \
	fi

scan-raw:
	python3 $(BUNDLE)/tools/scan.py $(DOC) $(ARGS)

clean:
	rm -rf dist build *.egg-info .pytest_cache webapp/dist

# ---- CLI shortcuts: every enano subcommand, latest code through the venv
# ---- ARGS forwards flags, DOC picks the scan/watch input, QUERY feeds elevations

pull:
	$(PY) -m enano pull $(ARGS)

import:
	$(PY) -m enano import $(ARGS)

list:
	$(PY) -m enano list $(ARGS)

search:
	$(PY) -m enano search $(QUERY) $(ARGS)

models:
	$(PY) -m enano models $(ARGS)

update:
	$(PY) -m enano update $(ARGS)

upgrade:
	$(PY) -m enano upgrade $(ARGS)

use:
	$(PY) -m enano use $(ARGS)

info:
	$(PY) -m enano info $(ARGS)

rm:
	$(PY) -m enano rm $(ARGS)

prune:
	$(PY) -m enano prune $(ARGS)

verify:
	$(PY) -m enano verify $(ARGS)

scan:
	$(PY) -m enano scan $(DOC) $(ARGS)

walk:
	$(PY) -m enano walk $(ARGS)

watch:
	$(PY) -m enano watch $(DOC) $(ARGS)

elevators:
	$(PY) -m enano elevators $(ARGS)

elevations:
	$(PY) -m enano elevations $(QUERY) $(ARGS)

doctor:
	$(PY) -m enano doctor $(ARGS)

web:
	$(PY) -m enano web $(ARGS)
