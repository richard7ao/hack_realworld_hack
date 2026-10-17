#!/usr/bin/env bash
set -euo pipefail
robosim_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$robosim_root"
robosim_uv="${UV_BIN:-$(command -v uv || true)}"
if [ -z "$robosim_uv" ] && [ -x "$HOME/.local/bin/uv" ]; then robosim_uv="$HOME/.local/bin/uv"; fi
if [ -z "$robosim_uv" ]; then echo 'Install uv or set UV_BIN before setting up RoboSimStudio.' >&2; exit 1; fi
if [ -x /Library/Developer/CommandLineTools/usr/bin/git ]; then export PATH="/Library/Developer/CommandLineTools/usr/bin:$PATH"; fi
export UV_CACHE_DIR="${UV_CACHE_DIR:-${TMPDIR:-/tmp}/faultline-uv-cache}"
"$robosim_uv" venv --allow-existing --python "${ROBOSIM_PYTHON_VERSION:-3.12}" .venv-robosim
"$robosim_uv" pip install --python .venv-robosim/bin/python --overrides backend/requirements-robosim.lock.txt -r backend/requirements-robosim.lock.txt
robosim_source="${ROBOSIM_SOURCE:-$robosim_root/third_party/robosimstudio}"
if [ ! -f "$robosim_source/robosimstudio/__init__.py" ]; then
  robosim_source="$robosim_root/.venv-robosim/source"
  mkdir -p "$robosim_source"
  robosim_archive="$(mktemp "${TMPDIR:-/tmp}/faultline-robosim.XXXXXX")"
  trap 'rm -f "$robosim_archive"' EXIT
  curl --fail --location --retry 0 'https://github.com/robosimstudio/robosimstudio/archive/73739abe212f963e8a9f5862b27bca370df091a7.tar.gz' -o "$robosim_archive"
  tar -xzf "$robosim_archive" -C "$robosim_source" --strip-components=1
fi
printf '%s\n' "$robosim_source" > .venv-robosim/robosim-source.txt
PYTHONPATH="$robosim_source${PYTHONPATH:+:$PYTHONPATH}" .venv-robosim/bin/python -c 'import robosimstudio, newton, mujoco; print("RoboSimStudio", robosimstudio.__version__, "Newton", newton.__version__, "MuJoCo", mujoco.__version__)'
echo 'Isolated CPU runtime ready. Run .venv/bin/python scripts/smoke_robosim.py for measured native physics evidence.'
