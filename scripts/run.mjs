#!/usr/bin/env node
/**
 * run.mjs -- the composite action's single entry point (action.yml runs
 * `node "${{ github.action_path }}/scripts/run.mjs"`). Orchestrates, in
 * order: resolve languages+roots, load the pinned indexers, then for each
 * language create one upload, install+verify the indexer, index every root of
 * the language, merge them into one repo-relative index, and upload that
 * through the CI upload door.
 *
 * ONE INDEX PER LANGUAGE. Rhumb stores one index per (repository, commit,
 * language), and every indexer writes paths relative to the root it ran in.
 * The roots of a language are therefore merged (scip-merge.mjs) before the
 * single upload, which is what Rhumb's own indexer publishes.
 *
 * ALL OR NOTHING PER LANGUAGE. When any root of a language fails to index,
 * nothing of that language is uploaded: a partial index would publish a
 * coverage hole as if it were the whole language. The upload is failed naming
 * each failed root; roots that did index are listed as indexed-not-uploaded.
 *
 * Fail-soft throughout: a failure at any stage for one language's
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
 * VERIFY-TIMEOUT (opt-in). A rejection the worker records after this step
 * exits is invisible to fail-on-error. A `verify-timeout` above zero polls
 * every upload left in `uploaded` once all pipelines have run (verify.mjs);
 * it spends runner minutes, so the default is off.
 *
 * UPLOAD CREATED BEFORE INDEXING. `processLanguage` creates the upload FIRST
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
import { mergeScipIndexes } from './scip-merge.mjs';
import { UploadDoorClient, describeFailureForDoor } from './door-client.mjs';
import { uploadIndex } from './upload.mjs';
import { writeGithubOutput, appendStepSummary } from './gh-output.mjs';
import { parseVerifyTimeout, verifyUploads } from './verify.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACTION_ROOT = path.resolve(__dirname, '..');
const DEFAULT_BASE_URL = 'https://rhumb.sh';

const EMPTY_OUTPUTS = { 'upload-ids': '{}', bytes: '{}', 'durations-ms': '{}', 'verify-statuses': '{}' };

/** Longest response body echoed into the step summary. */
const MAX_BODY_ECHO_CHARS = 500;

/** The door keeps this much of a failure reason (the door client cuts at the same length). */
const MAX_DOOR_REASON_CHARS = 500;

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
 * that runs the repository's build (Java, C#, C/C++) is indexed only when
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

function formatSeconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Runs one language's pipeline: create the upload, then install, index every
 * root into its own scratch directory, merge, and upload once (see the module
 * doc's "UPLOAD CREATED BEFORE INDEXING" and "ALL OR NOTHING PER LANGUAGE").
 *
 * `roots` is `[{root, project}]` in declared order; `root` is relative to
 * `repoRoot`. `ensureInstalled` is a caller-supplied closure so the
 * per-language install cache (`installedBins`) stays owned by `main`, not
 * duplicated here. Per-root outcome lines go to `log` as they happen and come
 * back as `rootLines` for the step summary. Scratch space lives under
 * `RUNNER_TEMP` and is removed afterwards; nothing is written into the
 * checkout. Never throws -- always returns `{ label, result, rootLines }`.
 */
export async function processLanguage({
  door,
  lang,
  roots,
  repoRoot,
  ensureInstalled,
  meta,
  runIndexerImpl = runIndexer,
  uploadIndexImpl = uploadIndex,
  mergeImpl = mergeScipIndexes,
  log = console.log,
}) {
  const label = lang;
  const rootLines = [];
  const unrecorded = (reason) => ({ label, result: { lang, status: 'failed', uploadId: null, reason, recorded: false }, rootLines });

  let created;
  try {
    created = await door.createUpload(
      lang,
      roots.map(({ root }) => root),
    );
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

  const startedAt = Date.now();
  const record = (line) => {
    rootLines.push(line);
    log(line);
  };

  // Every index is written outside the checkout: a build must not see (or
  // clean away) it, and the checkout stays as the workflow left it.
  let scratchDir;
  try {
    const bins = await ensureInstalled();
    scratchDir = await mkdtemp(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'rci-index-'));

    const indexed = [];
    const failed = [];
    for (const [position, { root, project }] of roots.entries()) {
      const rootStartedAt = Date.now();
      const outputDir = path.join(scratchDir, `root-${position}`);
      try {
        await mkdir(outputDir);
        const scipPath = await runIndexerImpl(lang, path.resolve(repoRoot, root), bins, { project, outputDir });
        indexed.push({ root, scipPath });
        record(`OK      ${lang} @ ${root}: indexed in ${formatSeconds(Date.now() - rootStartedAt)}`);
      } catch (err) {
        failed.push({ root, err });
        record(`FAILED  ${lang} @ ${root}: ${messageOf(err)} (after ${formatSeconds(Date.now() - rootStartedAt)})`);
      }
    }

    if (failed.length > 0) {
      const forDoor = failed.map(({ root, err }) => `${root}: ${describeFailureForDoor(err)}`).join('; ');
      await door.failUpload(upload.uploadId, forDoor.slice(0, MAX_DOOR_REASON_CHARS));
      const notUploaded = indexed.length > 0 ? `; indexed but not uploaded: ${indexed.map(({ root }) => root).join(', ')}` : '';
      const reason = `nothing uploaded, a language is uploaded only when all its roots index; failed: ${failed.map(({ root }) => root).join(', ')}${notUploaded}`;
      return {
        label,
        result: { lang, status: 'failed', uploadId: upload.uploadId, reason, recorded: true, durationMs: Date.now() - startedAt },
        rootLines,
      };
    }

    const merged = await mergeImpl({
      inputs: indexed,
      outputPath: path.join(scratchDir, 'merged.scip'),
      projectRootUri: pathToFileURL(repoRoot).href,
    });
    const result = await uploadIndexImpl(door, lang, merged.path, meta, upload);
    if (result.durationMs !== undefined) result.durationMs = Date.now() - startedAt;
    return { label, result, rootLines };
  } catch (err) {
    await door.failUpload(upload.uploadId, describeFailureForDoor(err));
    return {
      label,
      result: { lang, status: 'failed', uploadId: upload.uploadId, reason: messageOf(err), recorded: true, durationMs: Date.now() - startedAt },
      rootLines,
    };
  } finally {
    if (scratchDir !== undefined) await rm(scratchDir, { recursive: true, force: true });
  }
}

async function runDryRun(baseUrl, roots, withheld, verifyTimeout) {
  const languages = languagesWithRoots(roots);
  const lines = ['# code-intel-action -- dry run', '', 'No network calls made. Detected languages and roots, and the request sequence a real run would make:', ''];

  if (languages.length === 0) {
    lines.push('_no indexable language detected under this checkout_');
  }

  for (const { lang, roots: langRoots } of languages) {
    const entries = langRoots.map((entry) => normalizeRootEntry(entry, lang, 'roots'));
    const names = entries.map(({ root, project }) => `${root}${project === undefined ? '' : ` (project ${project})`}`);
    lines.push(`## ${lang} @ ${names.join(', ')}`, '```');
    lines.push(`POST ${baseUrl}/api/code-intel/v1/uploads               {"lang":"${lang}","roots":${JSON.stringify(entries.map(({ root }) => root))}}`);
    lines.push(`PUT  <presigned put_url from create>                    <gzip'd index.scip: one repo-relative index for all ${lang} roots>`);
    lines.push(`POST ${baseUrl}/api/code-intel/v1/uploads/{id}/complete {"sha256":"...","raw_bytes":...}`);
    if (verifyTimeout > 0) {
      lines.push(`GET  ${baseUrl}/api/code-intel/v1/uploads/{id}          (polled for up to ${verifyTimeout} s)`);
    }
    lines.push('```', '');
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
  const { seconds: verifyTimeout, invalid: verifyTimeoutInvalid } = parseVerifyTimeout(env('RCI_VERIFY_TIMEOUT', '0'));

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
    await runDryRun(baseUrl, roots, withheld, verifyTimeout);
    return;
  }

  const languages = languagesWithRoots(roots);
  const summaryLines = ['# code-intel-action', ''];
  const uploadIds = {};
  const bytes = {};
  const durationsMs = {};
  const verifyTargets = [];

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
    const door = new UploadDoorClient({ baseUrl, audience });

    const { label, result, rootLines } = await processLanguage({
      door,
      lang,
      roots: langRoots.map((entry) => normalizeRootEntry(entry, lang, 'roots')),
      repoRoot,
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

    summaryLines.push(...rootLines);
    if (result.status === 'failed' || result.status === 'skipped') {
      const unrecordedNote = result.recorded === false ? ' (not recorded in the upload door: no upload id was minted)' : '';
      summaryLines.push(`${result.status.toUpperCase()}  ${label}: ${result.reason ?? ''}${unrecordedNote}`);
      markFailed();
    } else {
      summaryLines.push(`OK      ${label} -> ${result.status} (upload ${result.uploadId})`);
      // Only an upload still waiting on the worker has anything to verify.
      if (result.status === 'uploaded') verifyTargets.push({ label, uploadId: result.uploadId });
    }
  }

  let verifyStatuses = {};
  if (verifyTimeoutInvalid) {
    const note = `verify-timeout "${env('RCI_VERIFY_TIMEOUT', '')}" is not a non-negative number of seconds -- uploads were not verified.`;
    console.warn(`[code-intel-action] ${note}`);
    summaryLines.push(note);
  } else if (verifyTimeout > 0 && verifyTargets.length > 0) {
    const verified = await verifyUploads({
      door: new UploadDoorClient({ baseUrl, audience }),
      targets: verifyTargets,
      timeoutSeconds: verifyTimeout,
    });
    summaryLines.push(...verified.lines);
    verifyStatuses = verified.statuses;
    if (verified.failed) markFailed();
  }

  summaryLines.push(...skippedLines(withheld));
  await appendStepSummary(summaryLines.join('\n'));
  await writeGithubOutput({
    'upload-ids': JSON.stringify(uploadIds),
    bytes: JSON.stringify(bytes),
    'durations-ms': JSON.stringify(durationsMs),
    'verify-statuses': JSON.stringify(verifyStatuses),
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
