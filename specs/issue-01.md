## Goal
Create the trust foundation for the credential broker: opaque, non-guessable
credential locators. NO secret material ever passes through this code.

## Deliverables
- NEW `src/broker/locator.js` exporting:
  - `mintLocator()` → returns `{ id, issuedAt }` where id =
    `"loc_v1_" + base64url(32 random bytes)` via node:crypto.randomBytes
  - `parseLocator(raw)` → returns `{ id, version }` or THROWS `LocatorError`
  - `isValidLocator(raw)` → boolean, never throws
- `LocatorError` class with `code` field: `MALFORMED | WRONG_VERSION | EMPTY`

## Hard constraints
- Zero new dependencies (node:crypto only)
- Locator contains NO provider name, NO agent name, NO secret — pure random id
- `String(locator)` and `JSON.stringify(locator)` must never leak more than the id itself

## Acceptance criteria
- [ ] Round-trip: mint → parse returns identical id
- [ ] Tamper tests: flipped chars, empty string, wrong prefix, `loc_v9_…` all rejected with correct error codes
- [ ] Uniqueness: 10,000 mints produce 10,000 distinct ids (fast loop test)
- [ ] No-secret-leak test asserted above
- [ ] `npm test && npm run verify` pass; PR body includes real output + `Closes #<this>`
