#!/usr/bin/env node
// Exports this folder as the contents of the public mirror repository named in package.json's repository URL
// (github.com/charlesjhlee/n8n-nodes-divdio-work for now, D-22438; MIT, D-17853), as a .tgz with push-mirror.sh beside the files. The mirror is the package as it is here: this folder
// is its root, so .github/workflows/publish.yml lands where GitHub Actions runs it.
//
//   node products/work/integrations/n8n/scripts/export-mirror.mjs <out-dir>
//
// It writes <out-dir>/n8n-nodes-divdio-work-<version>-mirror.tgz. Run push-mirror.sh from the unpacked folder with a
// gh login that owns the mirror: it creates the public repo if missing, commits, pushes main, and pushes the <version> tag, which makes
// publish.yml publish to npm with provenance through npm Trusted Publishing (no npm token anywhere).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', 'dist', '.git']);
const SKIP_FILE = /\.tsbuildinfo$|\.tgz$/;

/** The files of the mirror, relative to this folder. */
export function mirrorFiles(dir = ROOT, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = path.join(rel, e.name);
    if (SKIP.has(e.name)) continue;
    if (e.isDirectory()) out.push(...mirrorFiles(dir, r));
    else if (!SKIP_FILE.test(e.name)) out.push(r);
  }
  return out.sort();
}

/** "owner/name" of the mirror on GitHub, from package.json's repository URL (D-22438: charlesjhlee for now). */
export function mirrorRepo(pkg) {
  const m = /github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?$/.exec(pkg.repository?.url ?? '');
  if (!m) throw new Error('package.json repository.url must be a github.com repository');
  return m[1];
}

export const PUSH = (version, repo) => `#!/bin/sh
# Pushes the divdio Work n8n nodes ${version} to github.com/${repo} and tags the release (KAN-10451).
# The tag starts .github/workflows/publish.yml, which publishes to npm with provenance.
# Needs git and the GitHub CLI (gh) signed in with an account that owns or can push to ${repo}.
set -eu
cd "$(dirname "$0")"
REPO="\${1:-${repo}}"
REMOTE="https://github.com/$REPO.git"
command -v gh >/dev/null || { echo "STOP: the GitHub CLI (gh) is not installed on this Mac."; exit 2; }
gh auth status >/dev/null 2>&1 || { echo "STOP: gh is not signed in. Run: gh auth login"; exit 2; }
echo "GitHub login: $(gh api user --jq .login)"
if gh repo view "$REPO" >/dev/null 2>&1; then
  echo "Repository $REPO is there."
else
  echo "Creating the public repository $REPO ..."
  gh repo create "$REPO" --public --description "divdio Work nodes for n8n: a trigger from Work webhooks and actions through the Work REST API"
fi
[ "$(gh repo view "$REPO" --json visibility --jq .visibility)" = PUBLIC ] || { echo "STOP: $REPO is not public."; exit 2; }
# npm lets a package have a Trusted Publisher only once it exists, so the very first publish needs a short-lived npm
# token as the repository's NPM_TOKEN secret. It is read without echo and goes only to GitHub's secret store.
PKG="$(node -p 'require("./package.json").name')"
if ! npm view "$PKG" name >/dev/null 2>&1 && ! gh secret list --repo "$REPO" | grep -q '^NPM_TOKEN'; then
  echo "$PKG is not on npm yet, so this first publish needs an npm token."
  echo "On npmjs.com: Access Tokens, Generate New Token, Granular, packages and scopes: read and write, org @divdio, 7 days."
  printf "Paste the token (it is not shown) and press Return: "
  stty -echo; read -r TOKEN; stty echo; echo
  [ -n "$TOKEN" ] || { echo "STOP: no token given."; exit 2; }
  printf '%s' "$TOKEN" | gh secret set NPM_TOKEN --repo "$REPO"
  unset TOKEN
  echo "NPM_TOKEN secret set on $REPO. After 0.1.0 is on npm, add the Trusted Publisher and delete the secret."
fi
rm -f push-mirror.sh.done
if [ ! -d .git ]; then git init -q -b main; fi
git add -A -- . ':!push-mirror.sh'
git -c user.name="divdio" -c user.email="support@divdio.com" commit -q -m "divdio Work nodes for n8n ${version}" || true
git remote remove origin 2>/dev/null || true
git remote add origin "$REMOTE"
gh auth setup-git >/dev/null 2>&1 || true
git push -u origin main
git tag -f ${version}
git push origin ${version}
echo "Pushed main and tag ${version}: see https://github.com/$REPO/actions"
`;

function main(argv) {
  const out = path.resolve(argv[0] ?? '.');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  if (pkg.private || pkg.license !== 'MIT') throw new Error('package.json must be public and MIT before it is mirrored (D-17853)');
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'n8n-mirror-'));
  for (const f of mirrorFiles()) {
    fs.mkdirSync(path.dirname(path.join(stage, f)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, f), path.join(stage, f));
  }
  fs.writeFileSync(path.join(stage, 'push-mirror.sh'), PUSH(pkg.version, mirrorRepo(pkg)), { mode: 0o755 });
  fs.mkdirSync(out, { recursive: true });
  const tgz = path.join(out, `n8n-nodes-divdio-work-${pkg.version}-mirror.tgz`);
  execFileSync('tar', ['-czf', tgz, '-C', stage, '.']);
  fs.rmSync(stage, { recursive: true, force: true });
  console.log(`${tgz} (${mirrorFiles().length} files + push-mirror.sh)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main(process.argv.slice(2));
