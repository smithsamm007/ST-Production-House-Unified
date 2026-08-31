---
name: Bug Fix
about: Template for automated fault-tolerant fix loops
title: 'fix: [Task ID] Short description'
labels: 'lane-2, ready'
assignees: ''
---

## Bug Identification
- **Task ID**: FIX-XXX
- **Affected Component**: `src/path/to/component`

## Failure Context & Error Logs
```text
(Paste relevant redacted error logs or failure stack trace here)
```

## Remediation Requirements
- [ ] Fail-closed error handling preserved
- [ ] Secrets and vault locators sanitized
- [ ] Deterministic unit test added covering regression
- [ ] Verification passes: `npm test && npm run verify`
