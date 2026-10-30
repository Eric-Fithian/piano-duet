#!/bin/sh
# Installs Piano Duet on an Apple Silicon Mac:
#   curl -fsSL https://piano-duet.vercel.app/install.sh | sh
# PIANO_DUET_HOME sets the install folder; PIANO_DUET_SETUP=0 skips the model download.
set -eu

REPOSITORY="https://github.com/Eric-Fithian/piano-duet.git"
TARGET="${PIANO_DUET_HOME:-$HOME/.piano-duet}"

fail() {
  printf 'Piano Duet: %s\n' "$1" >&2
  exit 1
}

[ "$(uname -s)" = Darwin ] || fail "Piano Duet runs on macOS only."
[ "$(uname -m)" = arm64 ] || fail "Piano Duet needs an Apple Silicon Mac (M1 or later)."
[ "$(sw_vers -productVersion | cut -d. -f1)" -ge 14 ] || fail "Piano Duet needs macOS 14 or later."
xcode-select -p >/dev/null 2>&1 || fail "Git is missing. Run 'xcode-select --install', then run this installer again."

SHELL_PATH="$PATH"
export PATH="$HOME/.local/bin:$PATH"
if ! command -v uv >/dev/null 2>&1; then
  printf 'Installing uv, the Python package manager...\n'
  curl -LsSf https://astral.sh/uv/install.sh | sh
fi
BIN="$(uv tool dir --bin)"

if [ -d "$TARGET/.git" ]; then
  printf 'Updating Piano Duet in %s\n' "$TARGET"
  git -C "$TARGET" pull --ff-only --quiet
else
  printf 'Downloading Piano Duet to %s\n' "$TARGET"
  git clone --quiet --depth 1 "$REPOSITORY" "$TARGET"
fi

cd "$TARGET"
uv sync --frozen --no-dev
if [ "${PIANO_DUET_SETUP:-1}" != 0 ]; then
  printf 'Downloading the models (about 3 GB, once)...\n'
  uv run --frozen --no-dev piano-duet setup
fi

mkdir -p "$BIN"
cat > "$BIN/piano-duet" <<LAUNCHER
#!/bin/sh
# Starts Piano Duet; 'piano-duet update' installs the latest version.
set -eu
cd "$TARGET"
if [ "\${1:-}" = update ]; then
  git pull --ff-only
  uv sync --frozen --no-dev
  exec uv run --frozen --no-dev piano-duet setup
fi
exec uv run --frozen --no-dev piano-duet "\$@"
LAUNCHER
chmod +x "$BIN/piano-duet"

printf '\nPiano Duet is installed. Start it with:\n\n  piano-duet\n\n'
case ":$SHELL_PATH:" in
  *":$BIN:"*) ;;
  *)
    PATH="$SHELL_PATH" "$(command -v uv)" tool update-shell
    printf 'Open a new Terminal window first, so the piano-duet command is found.\n'
    ;;
esac
