# Jules–Codex–GitHub Bridge

The `Jules-Codex-GitHub Bridge` workflow coordinates bounded Jules work on this private repository without exposing the Jules API key.

## Operating contract

- At most three Jules sessions may be active across the repository.
- Only one active Jules writer may own a PR.
- Attempts are sequential and limited to 1, 2, and 3.
- Each dispatch records an opaque session ID, attempt, and state in the PR conversation so Codex and maintainers share the same control record.
- Jules creates or corrects a PR; Codex verifies the diff, tests, mergeability, and GitHub Actions evidence.
- After the third unsuccessful attempt, Jules stops and Codex completes the remaining work.
- The bridge never merges a PR.

## Setup for a private repository

1. Keep the Google Jules GitHub app authorized for this repository.
2. Add the Jules API key as the Actions secret `JULES_API_KEY`.
3. Keep Actions permissions able to read contents and comment on pull requests.
4. Run the workflow manually with `create`, PR number, attempt `1`, starting branch, and a bounded prompt.
5. Use `status` to synchronize Jules state to the PR, `approve` after reviewing a plan, and `message` for correction attempts 2 or 3.

Session allocation is serialized briefly to enforce the three-session cap. The Jules sessions themselves are asynchronous and therefore continue in parallel. Prompts and API responses are written only to runner-temporary files; the API key is never placed in an output or PR comment.
