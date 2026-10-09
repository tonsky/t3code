#!/usr/bin/env bash
# Updates the personal patch branch from upstream, builds the macOS desktop app
# from it, and installs that build over the one in /Applications.
#
#   scripts/install-patched-desktop.sh [--no-update] [--no-install]
#
#   --no-update   build what is checked out; skip the fetch and rebase
#   --no-install  stop after the build; leave the zip in release/patched
#
# The build is unsigned and has no update feed, so it never replaces itself with
# an official release. The app it replaces goes to the Trash.
set -euo pipefail

UPSTREAM_REMOTE=origin
UPSTREAM_BRANCH=main
PATCH_BRANCH=tonsky-patches
BUNDLE_ID=com.t3tools.t3code
INSTALL_DIR=/Applications

update=true
install=true
for arg in "$@"; do
  case "$arg" in
    --no-update) update=false ;;
    --no-install) install=false ;;
    *)
      echo "Unknown option: $arg" >&2
      exit 2
      ;;
  esac
done

step() { printf '\n==> %s\n' "$*"; }
fail() {
  echo "error: $*" >&2
  exit 1
}

[ "$(uname -s)" = Darwin ] || fail "this script installs the macOS app only."

cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"

# Node is often only installed under mise, which a non-interactive shell does not activate.
if ! command -v node >/dev/null && command -v mise >/dev/null; then
  PATH="$(mise where node@24)/bin:$PATH"
fi
command -v node >/dev/null || fail "Node 24 is required (see docs/operations/development.md)."
# The build script spawns `vp` by name; the repo's own copy is enough.
PATH="$PWD/node_modules/.bin:$PATH"
export PATH

if $update; then
  step "Rebasing $PATCH_BRANCH onto $UPSTREAM_REMOTE/$UPSTREAM_BRANCH"
  [ -z "$(git status --porcelain --untracked-files=no)" ] ||
    fail "the working tree has uncommitted changes. Commit or stash them first."
  git fetch "$UPSTREAM_REMOTE" "$UPSTREAM_BRANCH"
  [ "$(git branch --show-current)" = "$PATCH_BRANCH" ] || git switch "$PATCH_BRANCH"
  git rebase "$UPSTREAM_REMOTE/$UPSTREAM_BRANCH" ||
    fail "the rebase stopped. Resolve it, run 'git rebase --continue', then rerun with --no-update."
fi

step "Installing dependencies"
if command -v vp >/dev/null; then
  vp install --frozen-lockfile
else
  COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm install --frozen-lockfile
fi

step "Building $(git describe --always --dirty)"
output_dir="$PWD/release/patched"
rm -rf "$output_dir"
# Either variable would bake an update feed into the build.
env -u GITHUB_REPOSITORY -u T3CODE_DESKTOP_UPDATE_REPOSITORY \
  node scripts/build-desktop-artifact.ts --platform mac --target zip --output-dir "$output_dir"
zip="$(find "$output_dir" -maxdepth 1 -name '*.zip' | head -n 1)"
[ -n "$zip" ] || fail "the build produced no zip in $output_dir."

if ! $install; then
  echo "Built $zip"
  exit 0
fi

step "Installing into $INSTALL_DIR"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
ditto -x -k "$zip" "$stage"
app="$(find "$stage" -maxdepth 1 -name '*.app' | head -n 1)"
[ -n "$app" ] || fail "$zip contains no app bundle."
name="$(basename "$app")"
destination="$INSTALL_DIR/$name"

# Land the new bundle next to the old one first, so the swap itself is two
# renames and a failed copy leaves the installed app untouched.
rm -rf "$destination.new"
mv "$app" "$destination.new"
if [ -e "$destination" ]; then
  mv "$destination" "$HOME/.Trash/${name%.app} $(date '+%Y-%m-%d %H.%M.%S').app"
fi
mv "$destination.new" "$destination"
echo "Installed $destination"

# The app may be the one running this script (a T3 Code terminal or agent), and
# quitting it takes this process down with it. The restart therefore runs in
# its own session, and only after the new bundle is already in place.
restart='
  if [ -n "$(lsappinfo find bundleID="$1")" ]; then
    osascript -e "tell application id \"$1\" to quit" >/dev/null 2>&1
    for _ in $(seq 1 120); do
      [ -z "$(lsappinfo find bundleID="$1")" ] && break
      sleep 0.5
    done
  fi
  open "$2"
'
step "Restarting $name"
if command -v perl >/dev/null; then
  perl -MPOSIX -e 'setsid(); exec @ARGV' /bin/bash -c "$restart" restart "$BUNDLE_ID" "$destination" \
    >/dev/null 2>&1 &
else
  nohup /bin/bash -c "$restart" restart "$BUNDLE_ID" "$destination" >/dev/null 2>&1 &
fi
