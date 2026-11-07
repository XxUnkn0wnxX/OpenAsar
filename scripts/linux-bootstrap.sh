#!/usr/bin/env bash

set -u

if (( $# < 1 )); then
  echo "Usage: $0 BOOTSTRAP_BIN [BOOTSTRAP_ARGS...]" >&2
  exit 2
fi

bootstrap_bin=$1
shift

if ! help_output=$("$bootstrap_bin" --help); then
  echo "Could not read help from Discord bootstrap binary: $bootstrap_bin" >&2
  exit 1
fi

if [[ $help_output =~ (^|[[:space:]])--no-gui([[:space:],=]|$) ]]; then
  headless_flag=--no-gui
elif [[ $help_output =~ (^|[[:space:]])--no-zenity([[:space:],=]|$) ]]; then
  headless_flag=--no-zenity
else
  echo "Discord bootstrap binary advertises no supported headless option (--no-gui or --no-zenity): $bootstrap_bin" >&2
  exit 1
fi

exec "$bootstrap_bin" "$headless_flag" "$@"
