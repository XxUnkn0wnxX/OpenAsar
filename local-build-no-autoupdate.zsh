#!/usr/bin/env zsh

set -euo pipefail

SCRIPT_DIR="${0:A:h}"
cd "$SCRIPT_DIR"

usage() {
    print -r -- "Usage: ./local-build-no-autoupdate.zsh [options]"
    print -r -- ""
    print -r -- "Builds tmp/app.asar with OpenAsar auto-update disabled."
    print -r -- ""
    print -r -- "Options:"
    print -r -- "  --update-repo <owner/repo>                 Override the auto-detected repository stamp"
    print -r -- "  --macos-recovery-timeout-seconds <seconds>  Build-time recovery timeout (default: 90)"
    print -r -- "  -mrts <seconds>                              Alias for the recovery timeout option"
    print -r -- "  -h, --help                                  Show this help"
    print -r -- ""
    print -r -- "Examples:"
    print -r -- "  ./local-build-no-autoupdate.zsh"
    print -r -- "  ./local-build-no-autoupdate.zsh --update-repo owner/repo"
    print -r -- "  ./local-build-no-autoupdate.zsh -mrts 60"
    print -r -- "  ./local-build-no-autoupdate.zsh --macos-recovery-timeout-seconds 60"
}

for argument in "$@"; do
    if [[ "$argument" = "-h" || "$argument" = "--help" ]]; then
        usage
        exit 0
    fi
done

normalized_args=()
for argument in "$@"; do
    if [[ "$argument" = "-mrts" ]]; then
        normalized_args+=("--macos-recovery-timeout-seconds")
    else
        normalized_args+=("$argument")
    fi
done
set -- "${normalized_args[@]}"

mkdir -p tmp

version="nightly-$(git rev-parse --short HEAD)-localtest"

echo "Building OpenAsar with auto-update disabled..."
echo "Version: $version"
echo "Output: tmp/app.asar"

node scripts/pack.js --disable-autoupdate --version "$version" --output tmp/app.asar "$@"
