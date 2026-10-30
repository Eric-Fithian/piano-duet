# Everyday commands; CI runs the same ones.
.PHONY: setup dev check lint test test-python test-js test-core benchmark site site-build

setup:
	uv sync --frozen
	uv run --frozen piano-duet setup
	npm ci
	npm ci --prefix site

dev:
	uv run --frozen piano-duet --reload

check: lint test

lint:
	uv run --frozen ruff check src tests

test: test-python test-js test-core

test-python:
	uv run --frozen pytest -q

test-js:
	node --test tests/*.test.mjs

test-core:
	npm run check:core
	npm run test:core

benchmark:
	uv run --frozen piano-duet benchmark

site:
	npm run dev --prefix site

site-build:
	npm run check --prefix site
	npm run build --prefix site
