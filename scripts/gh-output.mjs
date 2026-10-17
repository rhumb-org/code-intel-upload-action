/**
 * gh-output.mjs -- the two GitHub Actions file-based write protocols this
 * action uses. Both degrade to a console.log when the corresponding env
 * var is unset (running outside an Actions runner, e.g. a local `node
 * scripts/run.mjs` or a test), rather than throwing.
 */

import { appendFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export async function writeGithubOutput(kv) {
  const file = process.env.GITHUB_OUTPUT;
  if (file === undefined) {
    console.log(`[code-intel-action] outputs: ${JSON.stringify(kv)}`);
    return;
  }
  const delimiter = `__RCI_${randomUUID()}__`;
  const lines = Object.entries(kv).map(([key, value]) => `${key}<<${delimiter}\n${value}\n${delimiter}\n`);
  await appendFile(file, lines.join(''));
}

export async function appendStepSummary(markdown) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file === undefined) {
    console.log(markdown);
    return;
  }
  await appendFile(file, `${markdown}\n`);
}
