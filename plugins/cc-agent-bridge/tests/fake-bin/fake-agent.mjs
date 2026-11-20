#!/usr/bin/env node
// Stand-in for `codex` / `dsh` in tests. Behaviour is driven by FAKE_* environment variables.
import fs from 'node:fs';

const argv = process.argv.slice(2);
const env = process.env;

if (argv[0] === '--version') {
  console.log('fake-agent 9.9.9');
  process.exit(0);
}

let stdin = '';
try {
  stdin = fs.readFileSync(0, 'utf8');
} catch {}

if (env.FAKE_LOG) {
  fs.appendFileSync(
    env.FAKE_LOG,
    `${JSON.stringify({
      argv,
      cwd: process.cwd(),
      stdin,
      depth: env.CC_AGENT_BRIDGE_DEPTH ?? null,
      claudecode: env.CLAUDECODE ?? null,
      deepseekKey: env.DEEPSEEK_API_KEY ?? null,
      seen: env.FAKE_READ ? (fs.existsSync(env.FAKE_READ) ? fs.readFileSync(env.FAKE_READ, 'utf8') : null) : undefined,
    })}\n`,
  );
}

for (const spec of (env.FAKE_EDIT ?? '').split(';').filter(Boolean)) {
  const [file, content] = spec.split('=');
  fs.writeFileSync(file, content);
}

const o = argv.indexOf('-o');
if (o >= 0 && env.FAKE_LAST_MESSAGE) fs.writeFileSync(argv[o + 1], env.FAKE_LAST_MESSAGE);

const lines = env.FAKE_FIXTURE ? fs.readFileSync(env.FAKE_FIXTURE, 'utf8').split('\n').filter(Boolean) : [];
for (const line of lines) process.stdout.write(`${line}\n`);
if (env.FAKE_STDERR) process.stderr.write(env.FAKE_STDERR);

const sleepS = Number(env.FAKE_SLEEP ?? 0);
if (sleepS) await new Promise((resolve) => setTimeout(resolve, sleepS * 1000));
process.exit(Number(env.FAKE_EXIT ?? 0));
