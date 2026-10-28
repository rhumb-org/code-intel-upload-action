/**
 * languages.mjs -- the one place a language is defined. Root detection,
 * `.rci-index.yml` / `roots-override` validation, indexer install, the
 * indexer command line, and the upload's indexer name and version all read
 * the row here; adding a language is adding a row (plus its pin in
 * `indexer-pins.json` and its install function in `install.mjs`).
 *
 * A row says:
 *   indexerName / indexerVersion(pins)  what the upload records as the indexer
 *   binKey                              the indexer's key in the installed `bins`
 *   install(pins, binDir)               installs and verifies it; returns the binary path
 *   markers                             root markers as OR-ed groups of AND-ed files
 *   runsBuild                           indexing runs the repository's own build
 *                                       (Maven, Gradle). Such a language is
 *                                       opt-in: its roots come only from
 *                                       `.rci-index.yml` or `roots-override`,
 *                                       never from auto-detection (see
 *                                       `withholdBuildRoots` in detect.mjs), so a
 *                                       repository that does not declare it spends
 *                                       no CI minutes on it.
 *   optInNotice                         (runsBuild rows) the step-summary reason a
 *                                       detected but undeclared root is skipped
 *   acceptsProject                      a root entry may name a `project` file
 *   nodeIndexer                         the indexer is a Node process that needs a
 *                                       sized heap (see index-lang.mjs)
 *   command({absoluteRoot, output, project})
 *                                       -> { args, cwd? } for the indexer binary
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  installNpmIndexer,
  installRustAnalyzer,
  installScipJava,
  assertJdk,
  detectRustAnalyzerPlatformKey,
} from './install.mjs';

export const LANGUAGES = {
  typescript: {
    indexerName: 'scip-typescript',
    indexerVersion: (pins) => pins['scip-typescript']?.version ?? '',
    binKey: 'scipTypescript',
    install: (pins, binDir) => installNpmIndexer(pins['scip-typescript'], binDir),
    markers: [['tsconfig.json'], ['pnpm-workspace.yaml']],
    runsBuild: false,
    acceptsProject: true,
    nodeIndexer: true,
    // `project` is scip-typescript's positional project argument; without it a
    // pnpm workspace marker selects all its members, and other roots use
    // `<root>/tsconfig.json`. An explicit project wins over the marker.
    command({ absoluteRoot, output, project }) {
      const projectArgs = project === undefined ? [] : [project];
      if (project === undefined && existsSync(path.join(absoluteRoot, 'pnpm-workspace.yaml'))) {
        projectArgs.push('--pnpm-workspaces');
      }
      return { args: ['index', '--output', output, ...projectArgs], cwd: absoluteRoot };
    },
  },
  python: {
    indexerName: 'scip-python',
    indexerVersion: (pins) => pins['scip-python']?.version ?? '',
    binKey: 'scipPython',
    install: (pins, binDir) => installNpmIndexer(pins['scip-python'], binDir),
    markers: [['pyproject.toml'], ['setup.py'], ['setup.cfg']],
    runsBuild: false,
    acceptsProject: false,
    nodeIndexer: true,
    command: ({ absoluteRoot, output }) => ({ args: ['index', '--output', output], cwd: absoluteRoot }),
  },
  rust: {
    indexerName: 'rust-analyzer',
    indexerVersion: (pins) => pins['rust-analyzer']?.releaseTag ?? '',
    binKey: 'rustAnalyzer',
    install: (pins, binDir) => installRustAnalyzer(pins['rust-analyzer'], binDir, detectRustAnalyzerPlatformKey()),
    markers: [['Cargo.toml']],
    runsBuild: false,
    acceptsProject: false,
    nodeIndexer: false,
    // rust-analyzer takes the root as its own positional argument.
    command: ({ absoluteRoot, output }) => ({ args: ['scip', absoluteRoot, '--output', output] }),
  },
  java: {
    indexerName: 'scip-java',
    indexerVersion: (pins) => pins['scip-java']?.version ?? '',
    binKey: 'scipJava',
    // The JDK is the runner's own; check it before spending the download.
    install: async (pins, binDir) => {
      await assertJdk();
      return installScipJava(pins['scip-java'], binDir);
    },
    // Maven or Gradle; the topmost marker wins, so a multi-module build is one root.
    markers: [['pom.xml'], ['build.gradle'], ['build.gradle.kts'], ['settings.gradle'], ['settings.gradle.kts']],
    runsBuild: true,
    optInNotice: 'Java indexing runs your Maven or Gradle build; declare its roots in .rci-index.yml to enable it.',
    acceptsProject: false,
    nodeIndexer: false,
    // scip-java detects Maven or Gradle (and uses the repository's mvnw or
    // gradlew) from the working directory.
    command: ({ absoluteRoot, output }) => ({ args: ['index', '--output', output], cwd: absoluteRoot }),
  },
};

export const KNOWN_LANGUAGES = Object.keys(LANGUAGES);

export const BUILD_RUNNING_LANGUAGES = KNOWN_LANGUAGES.filter((lang) => LANGUAGES[lang].runsBuild);

export function languageDef(lang) {
  const def = Object.hasOwn(LANGUAGES, lang) ? LANGUAGES[lang] : undefined;
  if (def === undefined) throw new Error(`unknown language "${lang}"`);
  return def;
}
