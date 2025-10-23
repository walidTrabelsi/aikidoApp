#!/usr/bin/env node

/*
  check-deps.js
  - Validates all registry-based dependencies in package.json before install
  - Resolves semver ranges against npm registry metadata
  - Fails fast on unresolved/invalid specs
  - Warns on deprecated versions
  - Skippable with SKIP_NPM_CHECK=1
*/

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const COLORS = {
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

function logInfo(msg) { console.log(COLORS.cyan(msg)); }
function logWarn(msg) { console.warn(COLORS.yellow(msg)); }
function logErr(msg) { console.error(COLORS.red(msg)); }
function logOk(msg) { console.log(COLORS.green(msg)); }

function isSkippable() {
  return process.env.SKIP_NPM_CHECK === '1' || process.env.SKIP_NPM_CHECK === 'true';
}

function readPackageJson(rootDir) {
  const pkgPath = path.join(rootDir, 'package.json');
  const content = fs.readFileSync(pkgPath, 'utf8');
  return JSON.parse(content);
}

function getAllDeps(pkgJson) {
  return {
    ...(pkgJson.dependencies || {}),
    ...(pkgJson.devDependencies || {}),
    ...(pkgJson.optionalDependencies || {}),
    ...(pkgJson.peerDependencies || {}),
  };
}

function isGitOrFileSpec(versionSpec) {
  return /^(git\+|github:|bitbucket:|gitlab:|file:|link:)/.test(versionSpec);
}

function npmViewJson(args) {
  const cmd = `npm view ${args} --json`;
  const out = execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  if (!out.trim()) return null;
  try {
    return JSON.parse(out);
  } catch (_) {
    return null;
  }
}

function resolveVersion(name, spec) {
  try {
    // Ask npm to compute the resolved version for the range
    // This reliably returns a string or array of strings
    const data = npmViewJson(`"${name}@${spec}" version`);
    if (!data) return null;
    if (Array.isArray(data)) return data[data.length - 1] || null;
    if (typeof data === 'string') return data;
    // Some npm versions return an object if multiple fields; try common properties
    if (typeof data.version === 'string') return data.version;
    return null;
  } catch (_) {
    return null;
  }
}

function checkDeprecated(name, version) {
  try {
    const dep = npmViewJson(`"${name}@${version}" deprecated`);
    // dep can be string message, true, false, null, or undefined
    if (!dep) return false;
    if (typeof dep === 'string') return dep.length > 0;
    return Boolean(dep);
  } catch (_) {
    return false;
  }
}

function check() {
  const root = process.cwd();
  if (isSkippable()) {
    logWarn('Skipping dependency check due to SKIP_NPM_CHECK=1');
    return;
  }

  logInfo('Validating dependencies against npm registry...');

  const pkg = readPackageJson(root);
  const allDeps = getAllDeps(pkg);
  const names = Object.keys(allDeps);

  if (names.length === 0) {
    logOk('No dependencies to validate.');
    return;
  }

  const problems = [];
  let validatedCount = 0;

  for (const name of names) {
    const spec = allDeps[name];

    // Skip local/file/git specs
    if (isGitOrFileSpec(spec)) {
      logInfo(`- ${name}@${spec} -> skipped (git/file spec)`);
      continue;
    }

    // Skip workspace protocol
    if (/^workspace:/.test(spec)) {
      logInfo(`- ${name}@${spec} -> skipped (workspace spec)`);
      continue;
    }

    const version = resolveVersion(name, spec);
    if (!version) {
      problems.push(`${name}@${spec}`);
      logErr(`- ${name}@${spec} -> UNRESOLVABLE`);
      continue;
    }

    validatedCount += 1;
    const deprecated = checkDeprecated(name, version);
    const suffix = deprecated ? COLORS.yellow(' (deprecated)') : '';
    logOk(`- ${name}@${spec} -> ${version}${suffix}`);
  }

  if (problems.length > 0) {
    const msg = `Dependency check failed. Unresolvable specs:\n  - ${problems.join('\n  - ')}`;
    logErr(msg);
    process.exit(1);
  }

  logOk(`Dependency check passed. Validated ${validatedCount} packages.`);
}

check();
