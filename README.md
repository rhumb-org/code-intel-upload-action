# code-intel-action

GitHub Action that builds a [SCIP](https://github.com/sourcegraph/scip) code
intelligence index of your repository and uploads it to Rhumb Code Intel
(`rhumb-code-intel`), so Rhumb can answer symbol-level questions about your
code (definitions, references, implementations) from the exact commit your CI
ran on.

## What it does

On each run the action:

1. detects the languages and project roots in the checked-out tree
   (TypeScript, Python, Rust -- see [Root detection](#root-detection); Java
   and C# only where you declare them -- see [Java](#java) and [C#](#c));
2. creates one upload per language with Rhumb Code Intel, naming all of that
   language's roots and authenticating with your workflow's GitHub OIDC token
   (no long-lived secret);
3. installs the SCIP indexer for each language at the exact version pinned in
   [`indexer-pins.json`](indexer-pins.json), verifying the downloaded artifact
   against the pinned checksum before it is installed or run;
4. builds a SCIP index for each root of the language, in a scratch directory
   outside your checkout, and merges them into one index whose file paths are
   relative to the repository root;
5. uploads that one index and records the result.

Rhumb keeps one index per language per commit, so a language with several
roots is published as one merged index, never one per root. A language is
uploaded only if every one of its roots indexed: when any root fails, nothing
of that language is uploaded and the failure names each failed root (see
[Fail-soft](#fail-soft-and-how-a-failure-is-recorded)). A repository with a
single root at its top level uploads its indexer's output unchanged.

It is fail-soft by default: an indexing or upload failure is recorded and
shown in the step summary but does not fail your workflow, unless you opt in
with `fail-on-error`.

## Usage

```yaml
name: code-intel

on:
  push:
    branches: [main] # your default branch
  workflow_dispatch:

permissions:
  contents: read
  id-token: write # lets the action request a GitHub OIDC token

jobs:
  index:
    runs-on: ubuntu-latest
    timeout-minutes: 90
    steps:
      - uses: actions/checkout@v7
      - uses: rhumb-org/code-intel-upload-action@v1
```

Trigger on `push` to the default branch rather than `pull_request`: the index
must describe the merged tree, and a `pull_request` run checks out the
merge-preview commit, so it would index a SHA that never lands on the default
branch. `workflow_dispatch` lets you re-index on demand.

`id-token: write` is required: the OIDC token is how Rhumb knows which
repository an upload comes from. Pin the action to a full commit SHA instead
of `@v1` if your policy requires immutable references.

The action indexes whatever is checked out, so run `actions/checkout` first
and install any dependencies your language's indexer needs to resolve types
(for example `npm ci` for a TypeScript project) before this step.

## Requirements

- **Registered repository.** See [Onboarding](#onboarding).
- **Runner.** Linux or macOS, x64 or arm64 (rust-analyzer ships builds for
  exactly these four targets; Windows runners are not supported). The
  GitHub-hosted `ubuntu-latest` runner is the tested configuration.
- **JDK, for Java only.** JDK 17 or newer on the runner (`JAVA_HOME` or
  `PATH`); see [Java](#java). The action installs none.
- **Maven or Gradle, for Java only.** Maven, or Gradle 8 or newer -- the
  repository's own wrapper (`mvnw`, `gradlew`) when it has one.
- **.NET SDK, for C# only.** The SDK your repository builds with on the
  runner (`dotnet` on `PATH`, .NET 6 or newer); see [C#](#c). The action
  installs none.
- **Node.js.** The action installs Node 24 itself with `actions/setup-node`;
  you do not need to provide one. Running the scripts directly requires
  Node 22 or newer.
- **Network.** Outbound HTTPS to `registry.npmjs.org` (TypeScript and Python
  indexers), `github.com` (rust-analyzer and scip-java release downloads),
  the OIDC token endpoint GitHub provides, and Rhumb Code Intel (`rhumb.sh`
  by default). A Java root also reaches whatever repositories its own
  Maven or Gradle build uses (typically Maven Central and the Gradle plugin
  portal) and Maven Central for scip-java's compiler plugin. A C# root
  reaches `api.nuget.org` for the scip-dotnet package and whatever NuGet
  feeds its own restore uses.
- **Memory.** The TypeScript and Python indexers are Node processes that
  type-check your project. Each run gets a heap ceiling of at least 6 GB,
  scaled up to 80% of the runner's memory on larger runners; a large monorepo
  may need a larger runner.
- **Time.** Every network call and every indexer process has a timeout
  (indexing one root: 60 minutes; roots are indexed one after another). Set
  `timeout-minutes` on the job as well.

## Onboarding

A repository can only upload once Rhumb knows it. There is nothing to
configure in this action or in your workflow beyond the snippet above:

1. The repository must be added to a Rhumb workspace's watched repositories,
   with Rhumb's GitHub App able to read it. This is done on the Rhumb side
   (ask your Rhumb contact or workspace administrator); it is not
   self-service from this repository.
2. Rhumb records the repository's immutable GitHub repository id on its own,
   shortly after the repository is added. The upload door identifies a
   caller by the repository id inside its OIDC token, never by a name or
   header the workflow supplies.

Until both have happened, the door rejects uploads with HTTP 403
(`repository_not_registered`); the action reports that in the step summary
and otherwise leaves your workflow green.

## Data sent

The action talks to three kinds of host. Everything it sends to Rhumb Code
Intel (`base-url`, default `https://rhumb.sh`):

| Request | What it carries |
|---|---|
| OIDC token request (to GitHub) | Audience `<base-url>/api/code-intel/v1/uploads`. The resulting token is sent to Rhumb as a bearer credential on every door call; it identifies the repository, commit, ref, and workflow that produced it. |
| `POST /api/code-intel/v1/uploads` | The language and all of its root directories (relative paths) being indexed; one request per language. |
| `PUT` to a presigned storage URL returned by Rhumb | The gzip-compressed SCIP index of that language: the indexes of all its roots merged into one. A SCIP index describes your code's symbols: file paths, symbol names and signatures, definition and reference locations, and documentation comments. It is not a copy of your source files. |
| `POST /api/code-intel/v1/uploads/{id}/complete` | The SHA-256 and size of the uncompressed index, the indexer name and version, the action version, and a `deps_installed` flag. |
| `POST /api/code-intel/v1/uploads/{id}/fail` (on failure only) | A failure reason of at most 500 characters: an HTTP status and response summary, or -- when an indexer or `npm` process failed -- only its exit code, signal, and whether it timed out. The command line and the process's output stay in your step summary and are not sent. |

To download indexers it contacts `registry.npmjs.org` and `github.com`; those
requests carry no data from your repository (the scip-dotnet package comes
from `api.nuget.org`). Indexing a Java or C# root runs your own build, which
contacts the repositories and feeds it is configured for, exactly as your
normal CI does. Because `base-url` receives your
OIDC token and your index, point it only at a service you trust.

`dry-run: true` prints the request sequence without any network call, which
is a safe way to see what a real run would do.

## Fail-soft, and how a failure is recorded

Before installing or indexing a language, the action creates its upload with
Rhumb (`POST /uploads`). Any later failure for that language -- install, an
indexer process dying (for example an out-of-memory kill), the merge, or the
upload itself -- is then reported against that upload (`POST
/uploads/{id}/fail`, recorded as `failed_in_ci`) and listed in the step
summary. A language is all or nothing: if one root fails to index, the other
roots are still indexed so every failure is reported, but nothing of the
language is uploaded, because a partial index would present itself as the
whole language. The failure names each failed root (the reason sent to Rhumb
is `<root>: <exit code, signal or timeout>` per root) and the step summary
lists the roots that indexed but were not uploaded. Each root's `OK` or
`FAILED` line, with its duration, is also printed to the job log as it
happens. A run can still end green with a failed language; if you want a red
mark, set `fail-on-error` (below). The one case with no record on Rhumb's side
is when the upload could not be created at all (door unreachable,
unregistered repository, rejected token): the step summary then shows the
HTTP status and response body and says it was not recorded.

## Inputs

| Input | Default | Description |
|---|---|---|
| `base-url` | `https://rhumb.sh` | Base URL of the Rhumb Code Intel service. It receives your OIDC token and the index uploads. |
| `roots-override` | `''` | JSON object overriding detected/declared roots, e.g. `{"typescript":["packages/api"],"python":["services/worker"]}`. See "Root detection" below. |
| `fail-on-error` | `false` | When `true`, the step exits non-zero once every language has been attempted and recorded, if any of them failed to index or upload (or roots could not be resolved or the pinned indexers could not be loaded). Opt in only from a workflow that is not a required check: the upload failure then shows as a red check on the commit or PR without blocking merges. |
| `dry-run` | `false` | Resolve languages/roots and print the request sequence a real run would make. No network calls, no installs, no indexing. |

## Outputs

| Output | Description |
|---|---|
| `upload-ids` | JSON object mapping `"<language>"` -> upload id (or `null` only when the door was unreachable at that language's upload-creation call). |
| `bytes` | JSON object mapping `"<language>"` -> `{raw_bytes, compressed_bytes}` of the merged index. |
| `durations-ms` | JSON object mapping `"<language>"` -> duration in milliseconds of that language's whole pipeline: indexing every root, merging, and uploading. |

Earlier versions keyed these by `"<language> @ <root>"`, one entry per root.

## Root detection

The action walks the checked-out tree (bounded depth, skipping
`node_modules`, `target`, `dist`, and other vendor/build directories) and
auto-detects, per language, every directory that carries that language's
project marker:

- **TypeScript** — a directory with a root `tsconfig.json` alone (no
  sibling `package.json` required), OR a `pnpm-workspace.yaml` alone (a
  declared pnpm monorepo's members are indexed together from that one
  marker).
- **Python** — a directory with `pyproject.toml`, `setup.py`, or
  `setup.cfg`. A `pyproject.toml` only counts when it declares a `[project]`
  or `[build-system]` table; a tool-config-only file (e.g. a pytest-only
  `[tool.pytest.ini_options]`) is not a python root -- declare it explicitly
  via `.rci-index.yml` if it should be indexed anyway.
- **Rust** — a directory with `Cargo.toml`. A `Cargo.toml` only counts when
  it declares a bare `[package]` or `[workspace]` table header; one with
  neither (e.g. only a `[workspace.metadata]` child table) is not a rust
  root -- declare it explicitly via `.rci-index.yml` if it should be indexed
  anyway.
- **Java** — a directory with `pom.xml`, `build.gradle`,
  `build.gradle.kts`, `settings.gradle`, or `settings.gradle.kts`. Unlike the
  others, Java roots are never indexed from detection alone: see
  [Java](#java).
- **C#** — a directory with a `*.sln`, `*.slnx`, or `*.csproj` file. Like
  Java, C# roots are never indexed from detection alone: see [C#](#c).

**Topmost marker wins.** Once a directory matches a language's marker, the
walk does not look for that *same* language any further down that
directory's own subtree — a nested marker there belongs to the project the
topmost marker already declares, not a second independent root. This is
what keeps a multi-crate Cargo workspace (a root `Cargo.toml` plus several
member crates, each with their own `Cargo.toml`) to exactly ONE rust root,
and a pnpm workspace's per-member `tsconfig.json` files to exactly ONE
typescript root — instead of one competing SCIP index and upload per
nested crate or package. The rule is independent per language and per
branch of the tree: two unrelated sibling directories (say, a TypeScript
package and a Python service under different top-level folders) are each
still their own root, since neither is nested inside the other's matched
subtree.

**Rust's one exception.** A nested `Cargo.toml` that itself declares a
bare `[workspace]` table is a DISTINCT rust root, not a suppressed member
— `cargo metadata` refuses to resolve a crate that "believes it's in a
workspace when it's not" unless that nested `Cargo.toml` declares its own
`[workspace]`. A nested `[package]`-only `Cargo.toml` (an ordinary member
crate) still collapses into its enclosing workspace root as above; only a
nested `[workspace]` breaks back out, and it in turn suppresses its own
member crates the same way.

A layout the walk still gets wrong (an unusually deep nesting, or a marker
file present without a real project behind it) declares itself explicitly
via `.rci-index.yml` or the `roots-override` input instead of fighting the
walk's bounds — both take precedence over auto-detection, and either can
be used to *reduce* a workspace to fewer roots than the walk would find, or
to declare additional roots the walk's depth or exclusions miss.

### Java

Indexing Java runs your Maven or Gradle build (scip-java compiles the
project with its compiler plugin), so it runs in your CI, on your runner and
credentials, and it costs build minutes. It is therefore **opt-in**: a
repository that does not declare Java roots spends no CI time on it. When the
walk finds a Java build that is not declared, the step summary says so and
indexes nothing:

```
SKIPPED  java @ .: Java indexing runs your Maven or Gradle build; declare its roots in .rci-index.yml to enable it.
```

Declare the roots in `.rci-index.yml` (or the `roots-override` input), naming
the directory that holds the top-level build -- the root `pom.xml`, or the
directory with `settings.gradle(.kts)`; one root covers all its modules. An
explicit `java: []` silences the notice.

```yaml
roots:
  java:
    - .
```

The runner needs a JDK before this step; the action installs none, so the
build uses the JDK your workflow sets up:

```yaml
      - uses: actions/checkout@v7
      - uses: actions/setup-java@v6
        with:
          distribution: temurin
          java-version: '21'
      - uses: rhumb-org/code-intel-upload-action@v1
```

scip-java 0.13 needs JDK 17 or newer and, for Gradle builds, Gradle 8 or
newer. A missing or older JDK fails the Java root with that reason. scip-java
uses the repository's `mvnw` or `gradlew` when present, otherwise `mvn` or
`gradle` from `PATH`. It writes its index to a scratch directory outside your
checkout, and the build's own output (`target/`, `build/`) stays in the
workspace as in any build.

### C#

Indexing C# runs a NuGet restore and then loads your solution through
MSBuild (scip-dotnet opens the projects the way Visual Studio does, which
executes your build logic, source generators and analyzers), so it runs in your CI, on
your runner and credentials, and it costs build minutes. It is therefore
**opt-in**, exactly like Java: a repository that does not declare C# roots
spends no CI time on it. When the walk finds a solution or project that is
not declared, the step summary says so and indexes nothing:

```
SKIPPED  csharp @ .: C# indexing runs your MSBuild restore and project load; declare its roots in .rci-index.yml to enable it.
```

Declare the roots in `.rci-index.yml` (or the `roots-override` input), naming
the directory that holds the solution -- the topmost `*.sln` / `*.slnx`, or the
`*.csproj` of a project with no solution; one root covers every project in the
solution. An explicit `csharp: []` silences the notice.

```yaml
roots:
  csharp:
    - .
```

The runner needs the .NET SDK before this step; the action installs none, so
the restore and project load use the SDK your workflow sets up -- the one your
`global.json` asks for, if you have one:

```yaml
      - uses: actions/checkout@v7
      - uses: actions/setup-dotnet@v6
        with:
          global-json-file: global.json
      - uses: rhumb-org/code-intel-upload-action@v1
```

For each root the action runs `dotnet restore` on its solution (every `*.sln`
and `*.slnx` in the directory, else its `*.csproj`), then scip-dotnet, in that
directory and without restoring a second time. Restore uses the NuGet feeds and
credentials your repository and runner already have, so a private feed works the
same way it does in your normal CI (for example, `actions/setup-dotnet` with
`source-url` and `NUGET_AUTH_TOKEN`, or a credential provider). The index is written to a scratch directory outside your
checkout; the restore and project load still write `obj/` in the workspace as any
build does. scip-dotnet is installed from the pinned, hash-verified package
alone -- not from any feed in your NuGet configuration.

The index describes the projects as MSBuild loads them, so files your build
generates (under `obj/`) appear in it next to your sources.

### `.rci-index.yml`

An optional file at the repo root, checked in by the tenant, declaring
roots per language:

```yaml
roots:
  typescript:
    - packages/api
  python:
    - services/worker
  rust:
    - .
  java:
    - .
  csharp:
    - .
```

A language key present here **fully replaces** that language's
auto-detected roots for this run (an explicit empty list, `rust: []`,
skips that language entirely). A language absent from `.rci-index.yml`
keeps its auto-detected roots unchanged. No `.rci-index.yml` at all is a
no-op — auto-detection runs unmodified.

A TypeScript root whose project file is not `<root>/tsconfig.json` (say a
solution-style `tsconfig.graph.json`) names it with the object form; the
file is passed to scip-typescript as its positional project argument:

```yaml
roots:
  typescript:
    - path: .
      project: tsconfig.graph.json
    - packages/api   # bare paths still work, and mix freely
```

`project` is a path inside the root (absolute paths and `..` escapes are
rejected) and is only supported for TypeScript. An explicit project takes
precedence over pnpm workspace detection. Without it, a root containing
`pnpm-workspace.yaml` uses `--pnpm-workspaces` to index its members (with
`pnpm` available on `PATH`); other roots use `<root>/tsconfig.json`.

Only this shape (`roots:` -> `<language>:` -> `- <path>` or
`- path: <path>` plus an optional `project:` line), or an empty language
list such as `rust: []`, is supported. Other shapes (nonempty flow lists,
anchors, multi-document, tabs) fail loudly rather than being silently
mis-parsed.

### `roots-override` input

The same shape as `.rci-index.yml`'s `roots:` block (entries are a path
string or `{"path": ..., "project": ...}`), passed as a JSON string via the action's `roots-override` input. It is resolved AFTER
`.rci-index.yml`, so it takes precedence over both auto-detection and the
checked-in file for any language key it names.

## Troubleshooting

Start with the job's step summary: every root and every language is listed
there as `OK`, `FAILED`, or `SKIPPED` with its reason.

| Symptom | Likely cause and fix |
|---|---|
| `ACTIONS_ID_TOKEN_REQUEST_URL/_TOKEN unset` | The workflow or job lacks `permissions: id-token: write`. Pull requests from forks never receive an OIDC token, so uploads from fork PRs cannot work. |
| `create upload failed: HTTP 403 ... repository_not_registered` | The repository is not onboarded yet. See [Onboarding](#onboarding). |
| `create upload failed: HTTP 401 ...` | The token was rejected (wrong audience, expired, or an unexpected `base-url`). Leave `base-url` at its default unless Rhumb directs otherwise. |
| `create upload failed: ... fetch failed` or a timeout | Rhumb Code Intel was unreachable from the runner. The run is not recorded on Rhumb's side. |
| `downloaded tarball integrity ... does not match pinned` / `downloaded asset sha256 ... does not match pinned` | The downloaded indexer is not the pinned artifact and was not installed. Re-run; if it persists, open an issue. |
| `nothing uploaded, a language is uploaded only when all its roots index` | At least one root of that language failed; its own `FAILED` line says why. Fix or remove that root, and the language uploads as a whole. |
| `child process failed (exit code 134)` in the step summary | The indexer ran out of memory. Use a larger runner, or narrow the roots with `.rci-index.yml` / `roots-override`. |
| `child process failed (... killed (timed out))` | An indexer or `npm install` exceeded its timeout. |
| A TypeScript root fails with a missing project file | The root has no `tsconfig.json`; name the project file with the object form of `.rci-index.yml` (see above). |
| `no indexable language detected` | No root marker was found within the search depth. Declare roots explicitly with `.rci-index.yml` or `roots-override`. |
| `unsupported platform for rust-analyzer` | Rust indexing supports Linux and macOS on x64 and arm64 only. |
| `SKIPPED  java @ ...: Java indexing runs your Maven or Gradle build; declare its roots ...` | Java is opt-in. Declare the root in `.rci-index.yml` (see [Java](#java)). |
| `Java indexing needs a JDK 17+ on the runner ... none was found` or `... the runner's JDK is 11` | Add `actions/setup-java` with JDK 17 or newer before this step. |
| A Java root fails with `child process failed (exit code ...)` | Your Maven or Gradle build failed under scip-java; run `scip-java index` locally in that directory to see the build output, which stays in the step summary and is not sent to Rhumb. Gradle must be 8 or newer. |
| `the root has none of java's build files` | The declared Java root is not the directory holding `pom.xml` / `build.gradle(.kts)` / `settings.gradle(.kts)`. |
| `SKIPPED  csharp @ ...: C# indexing runs your MSBuild restore and project load; declare its roots ...` | C# is opt-in. Declare the root in `.rci-index.yml` (see [C#](#c)). |
| `C# indexing needs the .NET SDK on the runner ... none was found` or `... the runner's SDK is 5` | Add `actions/setup-dotnet` (the SDK your `global.json` asks for) before this step. |
| `C# indexing could not run \`dotnet --version\`: A compatible .NET SDK was not found` | Your `global.json` pins an SDK the runner does not have; set it up with `actions/setup-dotnet` and `global-json-file`. |
| A C# root fails with `child process failed ... dotnet restore` | NuGet restore failed -- usually a private feed without credentials on the runner. Run `dotnet restore` on the solution in that directory with the workflow's credentials; its output stays in the step summary and is not sent to Rhumb. |
| A C# root fails in `scip-dotnet` after a successful restore | MSBuild could not load a project (a workload, target framework or SDK the runner lacks). Run `dotnet build` on the solution in that directory to see why. |
| `the root has none of csharp's build files` | The declared C# root is not the directory holding the `*.sln` / `*.slnx` / `*.csproj`. |

## Pinned indexers

[`indexer-pins.json`](indexer-pins.json) pins the exact `scip-typescript` and
`scip-python` npm versions (with their `sha512` integrity), the
`rust-analyzer` release (with a `sha256` per platform), the `scip-java`
release (one platform-independent asset with its `sha256`), and the
`scip-dotnet` package from nuget.org (with its `sha256`). They ship with each
release of this action, so the indexers a workflow installs are decided by
the action version it references -- never by the `base-url` host. Downloaded
artifacts are hashed and compared before they are installed or executed, and
the rust-analyzer and scip-java downloads are restricted to the official
`github.com/rust-lang/rust-analyzer` and `github.com/scip-code/scip-java`
releases, and the scip-dotnet download to
`api.nuget.org/v3-flatcontainer/scip-dotnet/`. To bump an indexer, update the
version together with a checksum recomputed from the published artifact.

## License

Apache-2.0 -- see [LICENSE](LICENSE).
