# Coding Conventions (rules for all contributors, human or AI)

## Hard security rules (breaking these = PR rejected)
1. HTTPS-only URLs. Never use http://, localhost, private IPs, or embedded credentials.
2. Run FFmpeg/FFprobe ONLY via spawn with array arguments. Never build shell strings.
3. Never touch billing or enable paid tiers. Always check quota BEFORE calling a provider.
4. Every provider attempt writes an evidence-ledger row. Unverified success = failure.
5. Failures go to DLQ/quarantine/WAITING_FOR_QUOTA. Never silently dropped. Never retried without backoff.
6. Every durable job checkpoints after verified completion. Resume from last checkpoint only.
7. No secrets in code, logs, or test fixtures. Use the credential broker.
8. Internal agent names (JARVIS, LAKME...) never appear in public-facing output.

## Structural rules
9. Database migrations are numbered sequentially in sql/ (next number: 017). Never edit old migrations.
10. Every PR includes tests. New module = new unit test file.
11. Match the style of existing files in the same folder.
12. No new npm dependencies unless the issue explicitly requires one.
