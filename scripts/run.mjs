#!/usr/bin/env node
/**
 * run.mjs -- the composite action's single entry point (action.yml runs
 * `node "${{ github.action_path }}/scripts/run.mjs"`). Orchestrates, in
 * order: resolve languages+roots, load the pinned indexers, then for each
 * (language, root) pair create an upload, install+verify the indexer, index,
 * and upload the result through the CI upload door.
 *
 * Fail-soft throughout: a failure at any stage for one (language, root)
 * pipeline is caught, reported to `/fail` when an upload id already exists,
 * and recorded in the step summary -- `main` never throws and, by default,
 * this process never exits non-zero, so a broken or rejected upload never
 * turns the caller's own required checks red.
 *
 * FAIL-ON-ERROR (opt-in). A fail-soft run that ends green is invisible: a
 * repository whose uploads all fail would show only a green check forever.
 * `RCI_FAIL_ON_ERROR=true` (the `fail-on-error` input) makes the step exit
 * non-zero after every pipeline has run and been recorded, so a caller that
 * keeps this action out of its required checks gets a red mark on the
 * commit or PR without ever being blocked by it. Never the default.
 *
 * UPLOAD CREATED BEFORE INDEXING. `processRoot` creates the upload FIRST
 * (`door.createUpload`), before install or indexing run, so every later
 * failure -- install, the indexer child dying (e.g. an out-of-memory kill on
 * a large TypeScript root), or the upload itself -- has an id to `/fail`
 * against and shows up as a recorded failure. When creation itself fails
 * (door unreachable, unregistered repository, rejected token) there is no
 * id to fail against and nothing worth indexing: the pipeline stops there
 * and the step summary reports the status and body of the rejection and
 * says it was not recorded.
 *
 * `dry-run` never touches the network: it resolves languages+roots from the
 * checked-out tree exactly the way a real run would, then prints the request
 * sequence a real run would make and returns -- no OIDC mint, no install, no
 * index.
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { detectRoots, mergeRoots, withholdBuildRoots } from './detect.mjs';
import { loadRciIndexConfig, normalizeRootEntry } from './rci-index-config.mjs';
import { loadIndexerPins } from './pins.mjs';
import { LANGUAGES, KNOWN_LANGUAGES, languageDef } from './languages.mjs';
import { runIndexer } from './index-lang.mjs';
import { UploadDoorClient, describeFailureForDoor } from './door-client.mjs';
import { uploadIndex } from './upload.mjs';
import { writeGithubOutput, appendStepSummary } from './gh-output.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACTION_ROOT = path.resolve(__dirname, '..');
const DEFAULT_BASE_URL = 'https://rhumb.sh';

const EMPTY_OUTPUTS = { 'upload-ids': '{}', bytes: '{}', 'durations-ms': '{}' };

/** Longest response body echoed into the step summary. */
const MAX_BODY_ECHO_CHARS = 500;

function env(name, fallback = '') {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function parseBool(value) {
  return value === 'true' || value === '1';
}

function validateRootsShape(obj, sourceLabel) {
  for (const [lang, value] of Object.entries(obj)) {
    if (!KNOWN_LANGUAGES.includes(lang)) {
      throw new Error(`${sourceLabel}: unsupported language "${lang}" (expected one of ${KNOWN_LANGUAGES.join(', ')})`);
    }
    if (!Array.isArray(value)) {
      throw new Error(`${sourceLabel}: "${lang}" must be an array of roots`);
    }
    for (const entry of value) normalizeRootEntry(entry, lang, sourceLabel);
  }
}

/**
 * Resolves the roots to index, and the roots withheld as opt-in: a language
 * that runs the repository's build (Java, C/C++) is indexed only when
 * `.rci-index.yml` or `roots-override` names it (an explicit `[]` included --
 * that is a decision, not an omission), so a detected root of it that nothing
 * declares is reported as skipped instead.
 */
async function resolveRoots(repoRoot, rootsOverrideRaw) {
  const { roots: detected, withheld } = withholdBuildRoots(await detectRoots(repoRoot));
  const fromConfig = await loadRciIndexConfig(repoRoot);
  let merged = mergeRoots(detected, fromConfig);
  for (const lang of Object.keys(fromConfig ?? {})) delete withheld[lang];

  if (rootsOverrideRaw.trim().length > 0) {
    let override;
    try {
      override = JSON.parse(rootsOverrideRaw);
    } catch (err) {
      throw new Error(`roots-override is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    validateRootsShape(override, 'roots-override input');
    merged = mergeRoots(merged, override);
    for (const lang of Object.keys(override)) delete withheld[lang];
  }

  return { roots: merged, withheld };
}

function skippedLines(withheld) {
  return Object.entries(withheld).flatMap(([lang, langRoots]) =>
    langRoots.map((root) => `SKIPPED  ${lang} @ ${root}: ${LANGUAGES[lang].optInNotice}`),
  );
}

function languagesWithRoots(roots) {
  return Object.entries(roots)
    .filter(([, list]) => Array.isArray(list) && list.length > 0)
    .map(([lang, list]) => ({ lang, roots: list }));
}

async function loadActionVersion() {
  const pkg = JSON.parse(await readFile(path.join(ACTION_ROOT, 'package.json'), 'utf8'));
  return `code-intel-action@${pkg.version}`;
}

export async function installIndexerFor(lang, pins, binDir) {
  const def = languageDef(lang);
  const companions = def.installCompanions === undefined ? {} : await def.installCompanions(pins, binDir);
  return { ...companions, [def.binKey]: await def.install(pins, binDir) };
}

function messageOf(err) {
  return err instanceof Error ? err.message : String(err);
}

function echoBody(body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return text.length > MAX_BODY_ECHO_CHARS ? `${text.slice(0, MAX_BODY_ECHO_CHARS)}...` : text;
}

/**
 * Runs one (lang, root) pipeline: create the upload, then install+index,
 * then upload (see the module doc's "UPLOAD CREATED BEFORE INDEXING").
 * `ensureInstalled` is a caller-supplied closure so the per-language install
 * cache (`installedBins`) stays owned by `main`, not duplicated here. Never
 * throws -- always returns `{ label, result }`.
 */
export async function processRoot({
  door,
  lang,
  root,
  absoluteRoot,
  project,
  ensureInstalled,
  meta,
  runIndexerImpl = runIndexer,
  uploadIndexImpl = uploadIndex,
}) {
  const label = `${lang} @ ${root}`;
  const unrecorded = (reason) => ({ label, result: { lang, status: 'failed', uploadId: null, reason, recorded: false } });

  let created;
  try {
    created = await door.createUpload(lang, [root]);
  } catch (err) {
    return unrecorded(`create upload failed: ${messageOf(err)}`);
  }
  if (created.status !== 201 || typeof created.body?.upload_id !== 'string') {
    const hint =
      created.status === 401 || created.status === 403
        ? ' (the workflow needs `permissions: id-token: write` and the repository must be registered with Rhumb -- see the README)'
        : '';
    return unrecorded(`create upload failed: HTTP ${created.status} ${echoBody(created.body)}${hint}`);
  }
  const upload = { uploadId: created.body.upload_id, putUrl: created.body.put_url, maxBytes: created.body.max_bytes };

  // A language that runs the repository's build writes its index outside the
  // checkout, so the build never sees it.
  let scratchDir;
  try {
    const bins = await ensureInstalled();
    const indexerOptions = { project };
    if (LANGUAGES[lang]?.runsBuild) {
      scratchDir = await mkdtemp(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'rci-index-'));
      indexerOptions.outputDir = scratchDir;
    }
    const scipPath = await runIndexerImpl(lang, absoluteRoot, bins, indexerOptions);
    const result = await uploadIndexImpl(door, lang, scipPath, meta, upload);
    return { label, result };
  } catch (err) {
    await door.failUpload(upload.uploadId, describeFailureForDoor(err));
    return { label, result: { lang, status: 'failed', uploadId: upload.uploadId, reason: messageOf(err), recorded: true } };
  } finally {
    if (scratchDir !== undefined) await rm(scratchDir, { recursive: true, force: true });
  }
}

async function runDryRun(baseUrl, roots, withheld) {
  const languages = languagesWithRoots(roots);
  const lines = ['# code-intel-action -- dry run', '', 'No network calls made. Detected languages and roots, and the request sequence a real run would make:', ''];

  if (languages.length === 0) {
    lines.push('_no indexable language detected under this checkout_');
  }

  for (const { lang, roots: langRoots } of languages) {
    for (const entry of langRoots) {
      const { root, project } = normalizeRootEntry(entry, lang, 'roots');
      lines.push(`## ${lang} @ ${root}${project === undefined ? '' : ` (project ${project})`}`, '```');
      lines.push(`POST ${baseUrl}/api/code-intel/v1/uploads               {"lang":"${lang}","roots":["${root}"]}`);
      // A build-running language's index is written outside the checkout.
      const indexPath = LANGUAGES[lang].runsBuild ? 'index.scip' : `${root}/index.scip`;
      lines.push(`PUT  <presigned put_url from create>                    <gzip'd ${indexPath}>`);
      lines.push(`POST ${baseUrl}/api/code-intel/v1/uploads/{id}/complete {"sha256":"...","raw_bytes":...}`);
      lines.push('```', '');
    }
  }

  const skipped = skippedLines(withheld);
  if (skipped.length > 0) lines.push(...skipped, '');

  const summary = lines.join('\n');
  console.log(summary);
  await appendStepSummary(summary);
  await writeGithubOutput(EMPTY_OUTPUTS);
}

async function main() {
  const repoRoot = env('GITHUB_WORKSPACE', process.cwd());
  const baseUrl = env('RCI_BASE_URL', DEFAULT_BASE_URL).replace(/\/$/, '');
  const dryRun = parseBool(env('RCI_DRY_RUN', 'false'));
  const audience = `${baseUrl}/api/code-intel/v1/uploads`;
  const failOnError = parseBool(env('RCI_FAIL_ON_ERROR', 'false'));
  const markFailed = () => {
    if (failOnError) process.exitCode = 1;
  };

  let roots;
  let withheld;
  try {
    ({ roots, withheld } = await resolveRoots(repoRoot, env('RCI_ROOTS_OVERRIDE', '')));
  } catch (err) {
    await appendStepSummary(`# code-intel-action\n\nFAILED to resolve languages/roots: ${messageOf(err)}`);
    markFailed();
    await writeGithubOutput(EMPTY_OUTPUTS);
    return;
  }

  if (dryRun) {
    await runDryRun(baseUrl, roots, withheld);
    return;
  }

  const languages = languagesWithRoots(roots);
  const summaryLines = ['# code-intel-action', ''];
  const uploadIds = {};
  const bytes = {};
  const durationsMs = {};

  if (languages.length === 0) {
    summaryLines.push('No indexable language detected under this checkout -- nothing to index or upload.', ...skippedLines(withheld));
    await appendStepSummary(summaryLines.join('\n'));
    await writeGithubOutput(EMPTY_OUTPUTS);
    return;
  }

  let pins;
  try {
    pins = await loadIndexerPins();
  } catch (err) {
    summaryLines.push(`FAILED to load the pinned indexer versions: ${messageOf(err)}`, '', 'No languages were indexed.');
    markFailed();
    await appendStepSummary(summaryLines.join('\n'));
    await writeGithubOutput(EMPTY_OUTPUTS);
    return;
  }

  const binDir = path.join(repoRoot, '.rci-cache', 'bin');
  await mkdir(binDir, { recursive: true });
  const installedBins = {};
  const actionVersion = await loadActionVersion();

  for (const { lang, roots: langRoots } of languages) {
    for (const entry of langRoots) {
      const { root, project } = normalizeRootEntry(entry, lang, 'roots');
      const absoluteRoot = path.resolve(repoRoot, root);
      const door = new UploadDoorClient({ baseUrl, audience });

      const { label, result } = await processRoot({
        door,
        lang,
        root,
        absoluteRoot,
        project,
        ensureInstalled: async () => {
          if (installedBins[lang] === undefined) {
            installedBins[lang] = await installIndexerFor(lang, pins, binDir);
          }
          return installedBins[lang];
        },
        meta: { indexerName: LANGUAGES[lang].indexerName, indexerVersion: LANGUAGES[lang].indexerVersion(pins), actionVersion },
      });

      uploadIds[label] = result.uploadId ?? null;
      if (result.rawBytes !== undefined) {
        bytes[label] = { raw_bytes: result.rawBytes, compressed_bytes: result.compressedBytes };
      }
      if (result.durationMs !== undefined) durationsMs[label] = result.durationMs;

      if (result.status === 'failed' || result.status === 'skipped') {
        const unrecordedNote = result.recorded === false ? ' (not recorded in the upload door: no upload id was minted)' : '';
        summaryLines.push(`${result.status.toUpperCase()}  ${label}: ${result.reason ?? ''}${unrecordedNote}`);
        markFailed();
      } else {
        summaryLines.push(`OK      ${label} -> ${result.status} (upload ${result.uploadId})`);
      }
    }
  }

  summaryLines.push(...skippedLines(withheld));
  await appendStepSummary(summaryLines.join('\n'));
  await writeGithubOutput({
    'upload-ids': JSON.stringify(uploadIds),
    bytes: JSON.stringify(bytes),
    'durations-ms': JSON.stringify(durationsMs),
  });
}

// Run only when this file is the process entrypoint (`node run.mjs`, as
// action.yml invokes it) -- never as a side effect of a test importing
// `processRoot`, which would start a real indexing run over whatever tree
// the importer happens to sit in.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    if (parseBool(env('RCI_FAIL_ON_ERROR', 'false'))) process.exitCode = 1;
    console.error(`[code-intel-action] unexpected failure: ${err instanceof Error ? err.stack : err}`);
  });
}
