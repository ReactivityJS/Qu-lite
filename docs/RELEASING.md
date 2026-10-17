# Releasing

1. `main` is green in CI (tests incl. browser tests, Docker build).
2. Locally: `npm ci && npm test` twice (several tests are timing-based), `docker compose up --build` once.
3. Update `CHANGELOG.md`: move *Unreleased* to the new version with today's date; bump `version` in
   `package.json` (`npm version <x.y.z> --no-git-tag-version` keeps `package-lock.json` in sync).
4. Check what would be published: `npm pack --dry-run` (src, bin, examples, docs, README, CHANGELOG, LICENSE).
5. Commit `release: vX.Y.Z`, tag `vX.Y.Z`, push with tags; create a GitHub release from the changelog section.
6. Publish: `npm publish --access public` (scoped package; decide the final name/scope before the first publish).
