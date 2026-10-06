#!/bin/zsh
set -euo pipefail
cd -- "${0:A:h}"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"
exec uv run --frozen piano-duet "$@"
