#!/usr/bin/env node
import os from "node:os";

import { runCli } from "./cli-app.ts";

const code = await runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  home: os.homedir(),
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
});

process.exitCode = code;
