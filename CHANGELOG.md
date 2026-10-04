# Changelog

## [0.4.0](https://github.com/ayagmar/pi-extmgr/compare/v0.3.0...v0.4.0) (2026-10-04)

### ⚠ BREAKING CHANGES

* pi-extmgr now targets pi >= 1.0.1. Stay on pi-extmgr 0.3.x
  for older pi releases.

### Features

* attention widget and global manager shortcut ([5174c90](https://github.com/ayagmar/pi-extmgr/commit/5174c901a3da603c001f7b5f5988b9a0c81a3eed))
* **cli:** complete local package and profile names ([23115ee](https://github.com/ayagmar/pi-extmgr/commit/23115ee78d87413b11c087c1dd3f8e3c63b29dee))
* **cli:** improve extmgr command completion ([f7deaa1](https://github.com/ayagmar/pi-extmgr/commit/f7deaa17aaaf63c5203a690f8275f2748d3c26ff))
* **compatibility:** validate Pi and Node compatibility ([9c0f86e](https://github.com/ayagmar/pi-extmgr/commit/9c0f86e7099e87ae158da9e2633999e85749cc38))
* **doctor:** add runtime ownership explorer ([2231ac0](https://github.com/ayagmar/pi-extmgr/commit/2231ac0f27d504d73969309f33d89877c4e62103))
* **doctor:** detect command and tool conflicts ([f0a5389](https://github.com/ayagmar/pi-extmgr/commit/f0a5389160f21753da21132579eaf772701676f0))
* **doctor:** diagnose installed package compatibility ([b1ac79a](https://github.com/ayagmar/pi-extmgr/commit/b1ac79a43bdfc087b503c77014e43e32620887b7))
* **doctor:** expose runtime diagnostics command ([57e774a](https://github.com/ayagmar/pi-extmgr/commit/57e774abd1339f014e733b38c9eface50917d2a0))
* **history:** add package activity timelines ([87ad546](https://github.com/ayagmar/pi-extmgr/commit/87ad5468bb530f7b746ede403f727528dcfcd853))
* **history:** surface timelines in package details ([a819877](https://github.com/ayagmar/pi-extmgr/commit/a819877fe7c2c99d3fd09eaf19c63bc9049eceb4))
* **local:** add trash and undo for local extensions ([bec4920](https://github.com/ayagmar/pi-extmgr/commit/bec4920b36c0f93178f14c0de8fc86e0220224e1))
* **local:** wire trash and undo into removals ([f6b37de](https://github.com/ayagmar/pi-extmgr/commit/f6b37de6d7fd59af25d58a524eaa8bff5a1d68d5))
* **manager:** add bulk selection and package toggles ([e54b7f2](https://github.com/ayagmar/pi-extmgr/commit/e54b7f2f2f66316464cdc95dae761a765f0b096f))
* **manager:** compare and move package scopes ([eaacd07](https://github.com/ayagmar/pi-extmgr/commit/eaacd07db4b5b201b3eac23b1641b1eae85a94b1))
* **manager:** coordinate mutations and reload state ([f5e8d70](https://github.com/ayagmar/pi-extmgr/commit/f5e8d70f4b5f24b8370f2f4ecf3661124126324c))
* **manager:** coordinate persistent bulk actions ([72475bb](https://github.com/ayagmar/pi-extmgr/commit/72475bbb79cd5508d1f1db5b1ad93ab4d4a578e1))
* **manager:** expand package rows ([80144eb](https://github.com/ayagmar/pi-extmgr/commit/80144eba9e15d61ef07fb3ff651c1922022040ec))
* **manager:** expose safe package scope moves ([aec5de1](https://github.com/ayagmar/pi-extmgr/commit/aec5de143fa82eb5bedbc9799adf8ee0f435dfae))
* **manager:** save views and improve empty states ([66a3bc6](https://github.com/ayagmar/pi-extmgr/commit/66a3bc6d74a7231c6348c7f7f3ee63f1d2bbd1e6))
* **manager:** show package extension state ([3666b23](https://github.com/ayagmar/pi-extmgr/commit/3666b23b6fe1663f8f339e2e001022bc5e94cc17))
* **manager:** toggle whole package extension state ([3fdbc69](https://github.com/ayagmar/pi-extmgr/commit/3fdbc69c6fd38bd2a70ba54dd5b745a1cfd5f5a9))
* **manager:** wire saved views and favorites ([22cb0b7](https://github.com/ayagmar/pi-extmgr/commit/22cb0b74725ca1e44f39177e80af031c6c9087a2))
* **profiles:** add profile schema and exact package state ([dc3f665](https://github.com/ayagmar/pi-extmgr/commit/dc3f66568911d0433d38d5376ca402d8dfc3b400))
* **profiles:** compare profiles and add project policies ([aae7773](https://github.com/ayagmar/pi-extmgr/commit/aae7773fcf38c6962742a5a767f93a7651419253))
* **profiles:** export and dry-run apply ([151b6be](https://github.com/ayagmar/pi-extmgr/commit/151b6be75ac05b6370616740e2817ce5c8089274))
* **profiles:** expose export and dry-run commands ([c8fdfb6](https://github.com/ayagmar/pi-extmgr/commit/c8fdfb625c68132c419047d8da1139d5a48351a2))
* **profiles:** persist and safely apply named profiles ([9469adf](https://github.com/ayagmar/pi-extmgr/commit/9469adf634877ddbfb74a2bcf841e0ca11a64cb9))
* **reload:** persist pending reload requirements ([9efe03e](https://github.com/ayagmar/pi-extmgr/commit/9efe03e4917ceafac29c0dab9fdec4d735a00e15))
* **remote:** add package sorting ([e9626d1](https://github.com/ayagmar/pi-extmgr/commit/e9626d1439fc0edfae1b1bdfff0f26e277a8829d))
* **remote:** inspect package metadata before install ([44d2c41](https://github.com/ayagmar/pi-extmgr/commit/44d2c418b682ba5c9ee9cec763b42eb0df297817))
* **remote:** require consolidated install review ([49b18ba](https://github.com/ayagmar/pi-extmgr/commit/49b18ba8cbf9db014fc1fa8da66541172be4af13))
* **remote:** show installed and update badges ([76caa50](https://github.com/ayagmar/pi-extmgr/commit/76caa50983ec93cb64dceefab3802d5e56765f6e))
* **remote:** surface trust metadata in inspection ([7aca28a](https://github.com/ayagmar/pi-extmgr/commit/7aca28ab4dd535a97801effe52a12d4efa47a3dd))
* **remote:** wire badges and sorting into browser ([4d42783](https://github.com/ayagmar/pi-extmgr/commit/4d42783bd9b8e7c02521ebe5cfce07f4d0897d68))
* require pi 1.0 ([d1a4133](https://github.com/ayagmar/pi-extmgr/commit/d1a413309e4944ad7c394b2d0c264730aac49947))
* **trash:** expose persistent trash lifecycle commands ([58d70ba](https://github.com/ayagmar/pi-extmgr/commit/58d70ba7d8b43bb9d8c7d1b5f2d01e18d2984deb))
* **ui:** overlay report panes and workspace title reflection ([e58d472](https://github.com/ayagmar/pi-extmgr/commit/e58d472a4a5d965e36ab0474c9e17ea2ee679233))
* **ui:** report placements and remaining overlay migrations ([7ae17b2](https://github.com/ayagmar/pi-extmgr/commit/7ae17b20532146f2cfb8d6738214115f91d46f95))
* **ui:** split manager into task-oriented workspaces ([df53c27](https://github.com/ayagmar/pi-extmgr/commit/df53c2729b22f612fbe43cf9318253e58c5126d5))
* **ui:** streamline extension manager hints ([a13c924](https://github.com/ayagmar/pi-extmgr/commit/a13c92463ff37cf7afee8cdb40314a303b67d746))
* **updates:** add update policies and maintenance windows ([6aa6c32](https://github.com/ayagmar/pi-extmgr/commit/6aa6c32a7d85778abce7be4e9c59b1352c335025))
* **updates:** expose preview and selective updates ([dd25d67](https://github.com/ayagmar/pi-extmgr/commit/dd25d6755b016ec865deeb4ed168ba0ec1105678))
* **updates:** preview and selectively update packages ([7231b30](https://github.com/ayagmar/pi-extmgr/commit/7231b30b6ead961eedb24622cc2d4f81aad36398))

### Bug Fixes

* **auto-update:** read the schedule from the whole session, not the /tree branch ([6d35a72](https://github.com/ayagmar/pi-extmgr/commit/6d35a72751a5742bc53f7aaf249fe0bb2f543e2d))
* **bulk:** record bulk updates and removals in history ([160b1fa](https://github.com/ayagmar/pi-extmgr/commit/160b1faba7373f9c7ffbda91d07c26c2c85aabce))
* **ci:** keep the release Summary step green on real releases ([70e65dd](https://github.com/ayagmar/pi-extmgr/commit/70e65dd41ce2e606309881512cc5c255fb6b0338))
* **commands:** only autocomplete arguments the commands accept ([531dc9f](https://github.com/ayagmar/pi-extmgr/commit/531dc9fe06aad92fdbb37521122238fcd7eba192))
* **discovery:** fail enabling a local extension that a `!glob` still blocks ([1e28d6b](https://github.com/ayagmar/pi-extmgr/commit/1e28d6b36a897efd287ef5dbefcd8fc6b15bd6dd))
* **discovery:** honor pi's extensions setting overrides for local extensions ([53e632f](https://github.com/ayagmar/pi-extmgr/commit/53e632f199464eeb56c6e94ec07ee7c596ae5c8c))
* **discovery:** keep `+path` overrides when disabling a local extension ([70c61eb](https://github.com/ayagmar/pi-extmgr/commit/70c61eb29683ae8706ec4a1079f46dea979e70d0))
* **discovery:** list symlinked local extensions like pi does ([6bd95f7](https://github.com/ayagmar/pi-extmgr/commit/6bd95f7778b1965361550bf56137fc54f3afca44))
* **discovery:** never rename files inside a symlinked extension directory ([6997d41](https://github.com/ayagmar/pi-extmgr/commit/6997d41b88a9b96e7593fc39a3126311e24a4a34))
* **discovery:** undo the enable rename when the settings write fails ([9b39ecd](https://github.com/ayagmar/pi-extmgr/commit/9b39ecd49492bd92df6e1582825a8615b51cd064))
* **doctor:** detect command clashes between local extensions and stop claiming tool conflicts ([079159f](https://github.com/ayagmar/pi-extmgr/commit/079159f62cd48ddfb531cbd744ab651c2b5e0d88))
* **doctor:** detect command conflicts under pi's suffixed invocation names ([c66d867](https://github.com/ayagmar/pi-extmgr/commit/c66d8675c649fdf0846fe197ea119b21c4a81a16))
* **doctor:** evaluate partial caret/tilde ranges and Discover's pi engine ([10f613b](https://github.com/ayagmar/pi-extmgr/commit/10f613b33a5235fe5f908d532b3d7420ec9b88c8))
* follow pi 1.0 package locations and agent dir ([1d4d327](https://github.com/ayagmar/pi-extmgr/commit/1d4d327f812c0059cd613127be54f7bb292902b6))
* **history:** read --global history from pi's custom session dir ([623d903](https://github.com/ayagmar/pi-extmgr/commit/623d90379cd9534981015c0588422712c5706513))
* **install:** let standalone installs list pi's host-provided packages as dependencies ([1cd2914](https://github.com/ayagmar/pi-extmgr/commit/1cd2914f6b956844aae0c0484d4773da3e6833cf))
* **install:** show why a URL or standalone install failed ([be34ac0](https://github.com/ayagmar/pi-extmgr/commit/be34ac0d60c1724d3f45b39172a4df49d2779b45))
* keep console and package-manager output out of the fullscreen TUI ([7c27df6](https://github.com/ayagmar/pi-extmgr/commit/7c27df649865835f252cee6746f7e62a41c95d52))
* keep monthly update-check schedules from firing every millisecond ([7de82ef](https://github.com/ayagmar/pi-extmgr/commit/7de82efb9567b2009a7c636e01df1de167ea6dff))
* **manager:** close quietly when the loading screen is cancelled ([5d07721](https://github.com/ayagmar/pi-extmgr/commit/5d0772122893b4ecf0d0a4b7d764bebf3368ae63))
* **network:** enforce complete request timeouts ([69e9c77](https://github.com/ayagmar/pi-extmgr/commit/69e9c7745d2c02d73d36802e2cb78eb4c5e5fc16))
* **packages:** describe relative local packages from pi's resolved path ([3f33f99](https://github.com/ayagmar/pi-extmgr/commit/3f33f99a7572a31761a0d12ad1e82a6cadd09607))
* **packages:** harden extension management flows ([e077454](https://github.com/ayagmar/pi-extmgr/commit/e0774543a57fdd31e4ec7b61e32e65da2541cadd))
* **packages:** keep npm and git error output when the TUI suppresses it ([6e508e9](https://github.com/ayagmar/pi-extmgr/commit/6e508e9d0eb9d96b65ba14360612cd8ed914985c))
* **packages:** let update and remove take a bare npm name like install ([e4b2b81](https://github.com/ayagmar/pi-extmgr/commit/e4b2b814a3ebfff116badfca4c265b81f2781d28))
* **packages:** pass git+ and git:// sources to pi in a form it parses ([a2dcda7](https://github.com/ayagmar/pi-extmgr/commit/a2dcda7fb3c7f576ff773939300357802c3f2aaf))
* **packages:** preserve unknown filter settings ([381b8d3](https://github.com/ayagmar/pi-extmgr/commit/381b8d3e427e37f3ed9a31011bedf052533e6394))
* **packages:** run pi's update like `pi update` instead of gating it on an update check ([dff431b](https://github.com/ayagmar/pi-extmgr/commit/dff431b288c337beb874a21c3a21a9f8ac771b38))
* **profile:** accept options before the profile name ([0fdfa35](https://github.com/ayagmar/pi-extmgr/commit/0fdfa357bb8a23bcfc5270978134976c263ef13a))
* **profiles:** guard stores and partial applies ([77420b6](https://github.com/ayagmar/pi-extmgr/commit/77420b6e490717d989914d25225ede6358684d04))
* **profiles:** match floating npm ranges, tags and git branches when verifying installs ([dae6d06](https://github.com/ayagmar/pi-extmgr/commit/dae6d06888f26c68eec0031ed04f6fe1e37411b3))
* **profiles:** unify review and preflight diagnostics ([01d54ff](https://github.com/ayagmar/pi-extmgr/commit/01d54ff0d1c289a9b69305fbb383671056b4d7bc))
* **reload-state:** keep later writes working after one write fails ([c7e2b24](https://github.com/ayagmar/pi-extmgr/commit/c7e2b24b630a18674652dc9c2a2f62d2414299ba))
* **reload:** only treat a reload as done once pi retires the context ([8e38acc](https://github.com/ayagmar/pi-extmgr/commit/8e38acc66a3b67bfff07828662e50d8569f67295))
* **reload:** persist declined reload decisions ([ac38034](https://github.com/ayagmar/pi-extmgr/commit/ac3803442bb435c16541543e1bc388e0aea48880))
* **reload:** restore persisted state across sessions ([620b168](https://github.com/ayagmar/pi-extmgr/commit/620b16886d2d8ba4fd68d9dc4b738d148ff15d86))
* **remote:** cancel cleared package detail requests ([f3c607a](https://github.com/ayagmar/pi-extmgr/commit/f3c607a7dfadf97788784b62d38d317707b6dfb2))
* **remote:** harden npm browse rate limits ([59bdde1](https://github.com/ayagmar/pi-extmgr/commit/59bdde1987c2ab5bbaabe35290da31720461e16a))
* respect project trust for local extensions and installs ([90114c7](https://github.com/ayagmar/pi-extmgr/commit/90114c75b6e044486245ccf85c80a960021fbc34))
* **settings:** keep package settings writes scoped and trust-aware ([c1e71f3](https://github.com/ayagmar/pi-extmgr/commit/c1e71f32b26689a5ab0e31e09fdc29d2418e2ade))
* **settings:** preserve trust and public persistence semantics ([d2c323d](https://github.com/ayagmar/pi-extmgr/commit/d2c323d1d3528be285c810a0466d950b135b9dfb))
* **settings:** reject unsafe mutation writes ([08a00a5](https://github.com/ayagmar/pi-extmgr/commit/08a00a51d0f93f97a94b957bafe9bf857a3e2559))
* start the session even when the reload marker cannot be cleared ([67184f4](https://github.com/ayagmar/pi-extmgr/commit/67184f49ee7c41fc0c6e9f109c2c07c7829f665b))
* stop using the extension context after pi reloads it ([4f0c8cf](https://github.com/ayagmar/pi-extmgr/commit/4f0c8cf65bdbb421a1cbef39ba1c6549dbac7230))
* take npmCommand from pi's effective settings ([8949435](https://github.com/ayagmar/pi-extmgr/commit/89494357c5d2279036f23afa0b8d970631addcc8))
* **test:** fail load checks when a startup event handler throws ([98b64c3](https://github.com/ayagmar/pi-extmgr/commit/98b64c3108bde57b823e06909c51442640f12f76))
* **trash:** move extensions across filesystems ([29ef113](https://github.com/ayagmar/pi-extmgr/commit/29ef11315490a56e831b8418f7ca9608d8ee9aa8))
* **trash:** persist collision-safe undo records ([f68e0c5](https://github.com/ayagmar/pi-extmgr/commit/f68e0c5f66bcf493031c1f4606b7ec388c042240))
* **trash:** roll back unrecorded removals ([8b0b09c](https://github.com/ayagmar/pi-extmgr/commit/8b0b09c8d18b7925228c93d40c8f9eb48316fc1f))
* **ui:** harmonize help and trash actions ([8f6e05c](https://github.com/ayagmar/pi-extmgr/commit/8f6e05c97f0f991915f20d5ac4197ff92370f452))
* **ui:** honor configured selection bindings ([8b62ad0](https://github.com/ayagmar/pi-extmgr/commit/8b62ad0343c1b79b9994000f7b94c686d32b0641))
* **ui:** honor pi mode capabilities ([027867b](https://github.com/ayagmar/pi-extmgr/commit/027867b641c016f51b9324e5d4acc6fd1a855235))
* **ui:** prevent package output from corrupting TUI ([801a2d1](https://github.com/ayagmar/pi-extmgr/commit/801a2d14c17e30386c757eaa958983be11a14070))
* **ui:** refresh update state and center panes ([ce08027](https://github.com/ayagmar/pi-extmgr/commit/ce08027c3e2d40921b040aef62480a6bf2292f1e))
* **ui:** show the active cancel binding in report, loader and health hints ([0d32984](https://github.com/ayagmar/pi-extmgr/commit/0d329847f8cb918151a49b0126b85e8980f5ed34))
* **ui:** stabilize loading, focus, and terminal rendering ([668f2f5](https://github.com/ayagmar/pi-extmgr/commit/668f2f54ca3f8afb88b810a288d2cfba5d55ed6d))
* **ui:** suppress stale async rendering ([dfefe4a](https://github.com/ayagmar/pi-extmgr/commit/dfefe4a542054bdec97e594744673da5d8f36459))

### Performance Improvements

* **cache:** harden cache lifecycle ([491eb5f](https://github.com/ayagmar/pi-extmgr/commit/491eb5fd054db4fb083d54ceac6447688542fef0))
* **packages:** cache package entrypoint discovery ([4856534](https://github.com/ayagmar/pi-extmgr/commit/485653487df3fe901b3659fbbd7018decea3ef51))
* **packages:** reuse one package manager per extension discovery pass ([9948aae](https://github.com/ayagmar/pi-extmgr/commit/9948aae36673209a6977ba9430d1a986eafe12b9))
* **remote:** avoid cached search loader flicker ([f0fba27](https://github.com/ayagmar/pi-extmgr/commit/f0fba27d6465da24c3cffa54e9e15eaefb3fbcc1))

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
