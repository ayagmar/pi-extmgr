# Changelog

## [0.3.0](https://github.com/ayagmar/pi-extmgr/compare/v0.2.2...v0.3.0) (2026-05-11)

## [0.2.2](https://github.com/ayagmar/pi-extmgr/compare/v0.2.1...v0.2.2) (2026-05-07)

### Bug Fixes

* **extmgr:** harden npm reload handling ([555a049](https://github.com/ayagmar/pi-extmgr/commit/555a0492fa9f641dbc717dbe552efe8e4981f792))
* **extmgr:** refine npm command handling ([497a174](https://github.com/ayagmar/pi-extmgr/commit/497a174728528c4032188ecb45406002c104f90e))

## [0.2.1](https://github.com/ayagmar/pi-extmgr/compare/v0.2.0...v0.2.1) (2026-04-29)

### Bug Fixes

* **extmgr:** support pi 0.70 session startup ([60c4943](https://github.com/ayagmar/pi-extmgr/commit/60c4943de33b524daf88da5889ebfbd21f6464c5))

## [0.2.0](https://github.com/ayagmar/pi-extmgr/compare/v0.1.28...v0.2.0) (2026-04-20)

### Features

* **manager:** improve unified actions and fallback flows ([0628a5a](https://github.com/ayagmar/pi-extmgr/commit/0628a5acf34519ad04455d2db632079c9b16b920))
* **remote:** enrich browsing and cached metadata ([e38704e](https://github.com/ayagmar/pi-extmgr/commit/e38704e9b4cd24410e2c4f298d10919f3701c189))

### Bug Fixes

* **ci:** use packageManager pnpm version in release ([9c3a209](https://github.com/ayagmar/pi-extmgr/commit/9c3a2094c8723cddc0db98b24a0f698ce1b8f175))
* **extmgr:** harden manager state, cache TTL, and release flow ([3273687](https://github.com/ayagmar/pi-extmgr/commit/327368737fe53419b90ec58cc976d7e8605c4f57))
* **extmgr:** harden package config, summaries, and release guard ([10a28d7](https://github.com/ayagmar/pi-extmgr/commit/10a28d767964d2680310b2aa84aaae69b03b63da))

### Performance Improvements

* **history:** keep global session queries bounded ([1671851](https://github.com/ayagmar/pi-extmgr/commit/1671851bc44b97d4d0bb17023ea1e6dde28f51a8))

## Unreleased

- Expected release: TBD
- PR: TBD
- Authors: @ayagmar

### Added

- Documented new duration parsing and path identity utility work that supports history filters, scheduling, and path deduplication.

### Changed

- Release automation now serializes manual runs and only publishes from the default branch.
- Community browse caching now follows the shared search-cache path.

### Fixed

- Remote npm browsing fetches only the visible result page instead of crawling the full `pi-package` catalog, honors `Retry-After` on HTTP 429 responses, and reports exhausted rate limits inside the UI.
- Remote refresh bypasses both runtime and persistent search caches, community search stays scoped to `pi-package`, and author labels prefer usernames over fallback email addresses.
- Unified manager interactions keep staged changes, filters, and selection when returning from details, action menus, and stay-in-manager prompts.
- Disabled local extensions deduplicate correctly, manifest entrypoints only resolve real files, and npm author selection now prefers maintainer usernames before fallback emails.
- Metadata cache freshness no longer refreshes inherited stale fields.
- Package extension summaries now flatten multi-line tool descriptions before rendering, preventing TUI layout artifacts in the configure panel.
- Relative path selection rejects Windows absolute and UNC paths, and unified UI tests now use platform-safe temp directories.
