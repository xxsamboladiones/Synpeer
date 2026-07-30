#!/usr/bin/env node
/* global process, require */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(process.cwd());
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const EXCLUDED_DIRECTORIES = new Set([
  '.expo',
  '.git',
  '.playwright-cli',
  '.worktrees',
  'android',
  'dist',
  'dist-web-test',
  'ios',
  'node_modules',
  'test-results',
  'web-build',
]);
const BINARY_EXTENSIONS = new Set([
  '.gif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.keystore',
  '.mp3',
  '.mp4',
  '.pdf',
  '.png',
  '.sqlite',
  '.wasm',
  '.webm',
  '.webp',
  '.zip',
]);
const SECRET_PATTERNS = [
  {
    name: 'private-key-pem',
    pattern: /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/,
  },
  {
    name: 'supabase-secret-key',
    pattern: /\bsb_secret_[A-Za-z0-9._-]{12,}\b/,
  },
  {
    name: 'supabase-service-role-assignment',
    pattern:
      /\b(?:SUPABASE_)?SERVICE_ROLE(?:_KEY)?\s*[:=]\s*["']?(?!example|replace|your-)[^\s"'#]{16,}/i,
  },
  {
    name: 'aws-access-key',
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  },
  {
    name: 'github-token',
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{32,}\b/,
  },
  {
    name: 'openai-secret-key',
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,
  },
];

const findings = [];
scanDirectory(ROOT);

if (findings.length > 0) {
  process.stderr.write('Potential secrets found. Values are intentionally not printed.\n');
  for (const finding of findings) {
    process.stderr.write(`- ${finding.rule}: ${finding.file}\n`);
  }
  process.exitCode = 1;
} else {
  process.stdout.write('Secret scan passed: no high-risk credential patterns found.\n');
}

function scanDirectory(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) {
      continue;
    }

    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      scanDirectory(absolutePath);
      continue;
    }
    if (!entry.isFile() || BINARY_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      continue;
    }

    scanFile(absolutePath);
  }
}

function scanFile(absolutePath) {
  const stats = fs.statSync(absolutePath);
  if (stats.size > MAX_FILE_BYTES) {
    return;
  }

  const content = fs.readFileSync(absolutePath);
  if (looksBinary(content)) {
    return;
  }

  const text = content.toString('utf8');
  for (const rule of SECRET_PATTERNS) {
    if (rule.pattern.test(text)) {
      findings.push({
        file: path.relative(ROOT, absolutePath).replaceAll('\\', '/'),
        rule: rule.name,
      });
    }
  }
}

function looksBinary(content) {
  const inspectedBytes = Math.min(content.length, 1024);
  for (let index = 0; index < inspectedBytes; index += 1) {
    if (content[index] === 0) {
      return true;
    }
  }
  return false;
}
