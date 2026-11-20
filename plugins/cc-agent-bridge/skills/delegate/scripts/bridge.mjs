#!/usr/bin/env node
// cc-agent-bridge: delegate coding tasks from Claude Code to Codex or DeepSeek Harness.
import { main } from './lib/cli.mjs';

process.exitCode = await main(process.argv.slice(2));
