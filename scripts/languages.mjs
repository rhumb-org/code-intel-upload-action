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
 *   markers                             root markers as OR-ed groups of AND-ed files;
 *                                       `*.ext` matches any file with that extension
 *   runsBuild                           indexing runs the repository's own build
 *                                       (Maven, Gradle, MSBuild, CMake). Such a language is
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
 *   prepare({absoluteRoot, output})     (optional) the steps that run before the
 *                                       indexer, in order, each { file | binKey,
 *                                       args, cwd?, env?, maxBuffer? }: `file` is a
 *                                       command on the runner's PATH, `binKey` a tool
 *                                       installed by installCompanions. Scratch
 *                                       files belong beside `output`
 *   installCompanions(pins, binDir)     (optional) installs the other tools the
 *                                       prepare steps run; returns { binKey: path }
 *   missingBuildNotice                  (optional) the error for a declared root
 *                                       that carries none of `markers`
 *   command({absoluteRoot, output, project})
 *                                       -> { args, cwd?, env?, maxBuffer? } for the indexer binary
 */

import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  installNpmIndexer,
  installRustAnalyzer,
  installScipJava,
  installScipDotnet,
  installScipClang,
  installCmake,
  assertJdk,
  assertDotnetSdk,
  detectRustAnalyzerPlatformKey,
  detectScipClangPlatformKey,
  DOTNET_CLI_ENV,
} from './install.mjs';

/** A build prints a line per compiled file; the default 1 MiB capture would
 *  kill a large project's build part-way. */
const BUILD_OUTPUT_MAX_BYTES = 256 * 1024 * 1024;

/**
 * The solution files in a C# root (`.sln`, `.slnx`), else its project files
 * (`.csproj`), as absolute paths. A root with several solutions indexes all
 * of them; scip-dotnet indexes a project reachable from more than one only once.
 */
function csharpProjectFiles(absoluteRoot) {
  let names;
  try {
    names = readdirSync(absoluteRoot, { withFileTypes: true })
      .filter((entry) => !entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
  const solutions = names.filter((name) => /\.slnx?$/i.test(name));
  const files = solutions.length > 0 ? solutions : names.filter((name) => /\.csproj$/i.test(name));
  return files.map((name) => path.join(absoluteRoot, name));
}

/** The CMake build tree: beside the index, outside the checkout. */
function cmakeBuildDir(output) {
  return path.join(path.dirname(output), 'cmake-build');
}

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
    command: ({ absoluteRoot, output }) => ({
      args: ['index', '--output', output],
      cwd: absoluteRoot,
      maxBuffer: BUILD_OUTPUT_MAX_BYTES,
    }),
  },
  csharp: {
    indexerName: 'scip-dotnet',
    indexerVersion: (pins) => pins['scip-dotnet']?.version ?? '',
    binKey: 'scipDotnet',
    // The .NET SDK is the runner's own; check it before spending the download.
    install: async (pins, binDir) => {
      await assertDotnetSdk();
      return installScipDotnet(pins['scip-dotnet'], binDir);
    },
    // A solution, or else a project; the topmost marker wins, so a solution and
    // the projects under it are one root.
    markers: [['*.sln'], ['*.slnx'], ['*.csproj']],
    runsBuild: true,
    optInNotice: 'C# indexing runs your MSBuild restore and project load; declare its roots in .rci-index.yml to enable it.',
    acceptsProject: false,
    nodeIndexer: false,
    // scip-dotnet loads projects through MSBuild, which needs the NuGet
    // packages restored. The action restores them itself (with the runner's
    // credentials and feeds) and tells scip-dotnet not to restore again. A
    // positional project is resolved against the process's cwd, not against
    // --working-directory, so both are the root.
    prepare: ({ absoluteRoot }) =>
      csharpProjectFiles(absoluteRoot).map((file) => ({ file: 'dotnet', args: ['restore', file], cwd: absoluteRoot, env: DOTNET_CLI_ENV })),
    command: ({ absoluteRoot, output }) => ({
      args: ['index', '--output', output, '--working-directory', absoluteRoot, '--skip-dotnet-restore', ...csharpProjectFiles(absoluteRoot)],
      cwd: absoluteRoot,
      // The package's newest build targets the SDK the runner has; Major lets it
      // also run on a newer runtime than any build it ships (see the pin's note).
      env: { ...DOTNET_CLI_ENV, DOTNET_ROLL_FORWARD: 'Major' },
    }),
  },
  cpp: {
    indexerName: 'scip-clang',
    indexerVersion: (pins) => pins['scip-clang']?.version ?? '',
    binKey: 'scipClang',
    install: async (pins, binDir) => installScipClang(pins['scip-clang'], binDir, detectScipClangPlatformKey()),
    // The platform is checked first, before either download.
    installCompanions: async (pins, binDir) => ({ cmake: await installCmake(pins.cmake, binDir, detectScipClangPlatformKey()) }),
    markers: [['CMakeLists.txt']],
    runsBuild: true,
    optInNotice: 'C/C++ indexing runs your CMake configure and build; declare its roots in .rci-index.yml to enable it.',
    missingBuildNotice: 'C/C++ indexing needs a CMake project: the root has no CMakeLists.txt; declare the directory that holds it',
    acceptsProject: false,
    nodeIndexer: false,
    // Configure with the compilation database on, then build so generated
    // headers exist: scip-clang reads the compile commands and does not build.
    // An explicit job count: a bare `-j` is unbounded under `make`.
    prepare: ({ absoluteRoot, output, jobs = os.availableParallelism() }) => {
      const buildDir = cmakeBuildDir(output);
      return [
        {
          binKey: 'cmake',
          args: ['-S', absoluteRoot, '-B', buildDir, '-DCMAKE_EXPORT_COMPILE_COMMANDS=ON', '-DCMAKE_POLICY_VERSION_MINIMUM=3.5'],
          maxBuffer: BUILD_OUTPUT_MAX_BYTES,
        },
        { binKey: 'cmake', args: ['--build', buildDir, '-j', String(jobs)], maxBuffer: BUILD_OUTPUT_MAX_BYTES },
      ];
    },
    // scip-clang resolves source paths against its working directory, so it runs
    // from the root; its per-file progress lines are noise in the step summary.
    command: ({ absoluteRoot, output }) => ({
      args: ['--compdb-path', path.join(cmakeBuildDir(output), 'compile_commands.json'), '--index-output-path', output, '--no-progress-report'],
      cwd: absoluteRoot,
      maxBuffer: BUILD_OUTPUT_MAX_BYTES,
    }),
  },
};

export const KNOWN_LANGUAGES = Object.keys(LANGUAGES);

export const BUILD_RUNNING_LANGUAGES = KNOWN_LANGUAGES.filter((lang) => LANGUAGES[lang].runsBuild);

export function languageDef(lang) {
  const def = Object.hasOwn(LANGUAGES, lang) ? LANGUAGES[lang] : undefined;
  if (def === undefined) throw new Error(`unknown language "${lang}"`);
  return def;
}
