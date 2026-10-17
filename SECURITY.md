# Security policy

## Reporting a vulnerability

Please report security issues privately, not in a public issue or pull
request. Use GitHub's private vulnerability reporting: open the repository's
**Security** tab and choose **Report a vulnerability**.

Include what you found, the affected version or tag (`@v1`, a commit SHA),
and the steps to reproduce it. We will acknowledge the report and keep you
informed as it is investigated and fixed.

## Scope

This repository is a GitHub Action that runs inside a workflow on the
caller's runner. Of particular interest:

- anything that makes the action install or execute an indexer binary that
  does not match the version and checksum pinned in `indexer-pins.json`;
- anything that sends the workflow's OIDC token, or repository contents
  beyond the documented upload (see "Data sent" in the README), to a host
  other than the configured `base-url`.

Issues in the Rhumb Code Intel service itself, or in the third-party indexers
(`scip-typescript`, `scip-python`, `rust-analyzer`), are best reported to
their own maintainers.
