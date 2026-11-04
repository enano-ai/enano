PY := $(if $(wildcard .venv/bin/python),.venv/bin/python,python3)

.PHONY: install test web doctor clean

install:
	python3 -m venv .venv
	.venv/bin/pip install -e ".[dev]"

test:
	$(PY) -m pytest tests/

web:
	$(PY) -m enano web $(ARGS)

doctor:
	$(PY) -m enano doctor $(ARGS)

clean:
	rm -rf dist build *.egg-info .pytest_cache
