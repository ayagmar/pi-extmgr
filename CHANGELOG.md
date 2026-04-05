# Changelog

## Unreleased

- Expected release: TBD
- PR: TBD
- Authors: @ayagmar

### Added

- Documented new duration parsing and path identity utility work that supports history filters, scheduling, and path deduplication.

### Changed

- Release automation now serializes manual runs and only publishes from `main`.
- Community browse caching now follows the shared search-cache path.

### Fixed

- Unified manager interactions keep staged changes, filters, and selection when returning from details, action menus, and stay-in-manager prompts.
- Disabled local extensions deduplicate correctly, manifest entrypoints only resolve real files, and npm author selection now prefers maintainer usernames before fallback emails.
- Metadata cache freshness no longer refreshes inherited stale fields.
- Relative path selection rejects Windows absolute and UNC paths, and unified UI tests now use platform-safe temp directories.

