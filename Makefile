PY := $(if $(wildcard .venv/bin/python),.venv/bin/python,python3)
WEB_PORT ?= 8599
VITE_PORT ?= 5173
DOC ?= dev/sample-goal-notes.txt
BUNDLE ?= $(HOME)/.enano/models/personal-goals/latest

.PHONY: install test web web-kill web-restart doctor scan watch scan-raw webapp webapp-dev webapp-dev-kill clean

install:
	python3 -m venv .venv
	.venv/bin/pip install -e ".[dev]"

test:
	$(PY) -m pytest tests/

web:
	$(PY) -m enano web $(ARGS)

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

doctor:
	$(PY) -m enano doctor $(ARGS)

scan:
	$(PY) -m enano scan $(DOC) $(ARGS)

watch:
	$(PY) -m enano watch $(DOC) $(ARGS)

scan-raw:
	python3 $(BUNDLE)/tools/scan.py $(DOC) $(ARGS)

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

clean:
	rm -rf dist build *.egg-info .pytest_cache webapp/dist
