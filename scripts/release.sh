#!/usr/bin/env bash
#
# Publish attraverso to npm from a checkout of the public repo (DIST-5).
#
# From the public repo, never the private one, so what is on npm is built from source anyone can read: the
# script refuses to run anywhere whose origin is not alden12/attraverso. It also refuses unless the checkout is
# exactly origin/master with nothing uncommitted, and unless this version is not on npm yet - a publish cannot
# be taken back, and a version number cannot be reused even after an unpublish.
#
# Then: install from the lockfile, verify, build the standalone package, start it once to prove it boots and
# keeps stdout clean, publish (npm asks for 2FA in the browser), and tag the release.
#
#   yarn release              publish package.json's version
#   yarn release --dry-run    everything except the publish and the tag
#
# Named `release` because `yarn publish` is a Yarn builtin, which would shadow a script of that name.
set -euo pipefail

# `yarn run` points npm at Yarn's mirror (npm_config_registry=https://registry.yarnpkg.com) for every script it
# starts, and an `npm login` is saved for registry.npmjs.org, so under `yarn release` npm would report "not
# logged in" and publish to the wrong place. The registry is named here rather than inherited.
export npm_config_registry="https://registry.npmjs.org/"

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
dry_run=0
[ "${1:-}" = "--dry-run" ] && dry_run=1

fail() { echo "release: $*" >&2; exit 1; }

case "$(git remote get-url origin 2>/dev/null)" in
  *alden12/attraverso*) ;;
  *) fail "run this from a checkout of alden12/attraverso, so the package is built from the public source" ;;
esac

git fetch -q origin master
[ -z "$(git status --porcelain)" ] || fail "the checkout has uncommitted changes"
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/master)" ] || fail "HEAD is not origin/master: git checkout master && git pull"

name="$(node -p 'require("./package.json").name')"
version="$(node -p 'require("./package.json").version')"
# `npm view` prints the version when it exists and fails when it does not.
if npm view "$name@$version" version >/dev/null 2>&1; then
  fail "$name@$version is already on npm: bump the version in the private repo and let the export bring it here"
fi
if [ "$dry_run" -eq 0 ]; then
  npm whoami >/dev/null 2>&1 || fail "not logged in to npm: npm login"
fi

echo "Releasing $name@$version from $(git rev-parse --short HEAD)."
yarn install --frozen-lockfile --silent
yarn verify
yarn build:standalone

# The build is a different artefact from what `verify` tested, so start it once: with stdin closed it boots,
# loads a fresh store and exits. Anything on stdout would corrupt the protocol stream for every user.
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
node standalone/server.js --store "$scratch/smoke.apm.yaml" </dev/null >"$scratch/stdout" 2>"$scratch/stderr" ||
  { cat "$scratch/stderr" >&2; fail "the built server did not start"; }
grep -q "ready on stdio" "$scratch/stderr" || { cat "$scratch/stderr" >&2; fail "the built server never said it was ready"; }
[ ! -s "$scratch/stdout" ] || { head -5 "$scratch/stdout" >&2; fail "the built server wrote to stdout"; }
echo "The built server starts and keeps stdout clean."

if [ "$dry_run" -eq 1 ]; then
  npm publish standalone/ --dry-run
  echo "Dry run: nothing published, nothing tagged."
  exit 0
fi

npm publish standalone/
git tag -a "v$version" -m "$name $version"
git push -q origin "v$version"
echo "Published $name@$version and pushed tag v$version."
