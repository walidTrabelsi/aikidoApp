#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function log(msg) {
  console.log(`[audit] ${msg}`);
}

function fail(msg, err) {
  console.error(`[audit][error] ${msg}`);
  if (err) {
    if (err.stdout) {
      console.error(`[audit][stderr] ${err.stdout.toString()}`);
    }
    if (err.stderr) {
      console.error(`[audit][stderr] ${err.stderr.toString()}`);
    }
    if (err.message) {
      console.error(`[audit][message] ${err.message}`);
    }
  }
  process.exitCode = 1;
}

function parseArgs() {
  const [, , pkgArg, versionArg] = process.argv;
  if (!pkgArg) {
    console.error('Usage: node scripts/audit-version.js <package>[@<version>] OR <package> <version>');
    process.exit(1);
  }
  if (pkgArg.includes('@') && !pkgArg.startsWith('@')) {
    const [name, version] = pkgArg.split('@');
    return { packageName: name, version: version };
  }
  return { packageName: pkgArg, version: versionArg };
}

(function main() {
  const { packageName, version } = parseArgs();
  if (!packageName) {
    console.error('Package name is required');
    process.exit(1);
  }
  if (!version) {
    console.error('Version is required');
    process.exit(1);
  }

  log(`Running npm audit for ${packageName}@${version} without local install`);

  const tempDir = path.resolve(process.cwd(), `temp-audit-${Date.now()}`);
  const pkgJsonPath = path.join(tempDir, 'package.json');

  try {
    fs.mkdirSync(tempDir, { recursive: true });

    const packageJson = {
      name: 'security-audit-check',
      version: '1.0.0',
      private: true,
      dependencies: {
        [packageName]: version,
      },
    };

    fs.writeFileSync(pkgJsonPath, JSON.stringify(packageJson, null, 2));
    log('Generating package-lock.json (no install)...');

    try {
      execSync(
        'npm install --package-lock-only --ignore-scripts --no-bin-links --no-optional --silent --no-fund',
        {
          cwd: tempDir,
          stdio: 'pipe',
          timeout: 120000,
        }
      );
      log('package-lock.json generated');
    } catch (err) {
      throw new Error(`Failed to generate package-lock.json: ${err.message}`);
    }

    const lockPath = path.join(tempDir, 'package-lock.json');
    if (!fs.existsSync(lockPath)) {
      throw new Error('package-lock.json not created');
    }

    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    const resolvedVersion =
      (lock.packages && lock.packages[`node_modules/${packageName}`] && lock.packages[`node_modules/${packageName}`].version) ||
      (lock.dependencies && lock.dependencies[packageName] && lock.dependencies[packageName].version) ||
      null;

    if (resolvedVersion) {
      log(`Resolved version: ${resolvedVersion}`);
    } else {
      log('Could not determine resolved version from lockfile');
    }

    log('Running npm audit...');

    let auditData = null;
    try {
      const output = execSync('npm audit --signature-verification --json', {
        cwd: tempDir,
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 120000,
      });
      auditData = JSON.parse(output);
    } catch (err) {
      // non-zero exit code when vulnerabilities are found
      if (err.stdout) {
        try {
          auditData = JSON.parse(err.stdout.toString());
        } catch (parseErr) {
          throw err; // surface original
        }
      } else {
        throw err;
      }
    }

    // Print a concise summary
    if (auditData && auditData.vulnerabilities) {
      const vulns = auditData.vulnerabilities;
      const total = Object.values(vulns).reduce((acc, v) => acc + (v.via ? 1 : 0), 0);
      const bySeverity = { critical: 0, high: 0, moderate: 0, low: 0 };
      for (const [name, v] of Object.entries(vulns)) {
        const severity = v.severity || 'unknown';
        if (bySeverity[severity] !== undefined) bySeverity[severity] += 1;
      }
      console.log(JSON.stringify({ package: packageName, version: resolvedVersion || version, severityCount: bySeverity, vulnerabilities: vulns }, null, 2));
    } else {
      console.log(JSON.stringify({ package: packageName, version: resolvedVersion || version, message: 'No vulnerabilities reported' }, null, 2));
    }
  } catch (err) {
    fail('Audit failed', err);
  } finally {
    try {
      // Cleanup temp dir
      fs.rmSync(tempDir, { recursive: true, force: true });
      log('Cleaned up temporary directory');
    } catch (cleanupErr) {
      // ignore
    }
  }
})();
