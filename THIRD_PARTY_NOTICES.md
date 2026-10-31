# Third-Party Components

This project uses the public SPS Plugin SDK and documented public library APIs.
Private SPS Core source is not included. The build preserves linked legal comments
and copies the bundled packages' full upstream license/notice files into
`dist/third-party-notices`; that directory is part of the distribution allowlist.
This file does not assign a license to Builder's own source or the original
user-provided design files.

| Component | Use | Upstream License |
| --- | --- | --- |
| @sonparkserver/plugin-sdk, commit61a929f6 | Worker, state/manifest/UI contracts, build and conformance | Apache-2.0 |
| React / React DOM | Host-provided runtime; local preview development | MIT |
| @xyflow/react12.12.0 | Read-only architecture view | MIT |
| elkjs0.12.1 | Planned automatic layout; not yet used in the initial view | EPL-2.0 |
| lucide-react1.66.0 | UI icons | ISC |
| esbuild0.28.2 | Development/build tooling | MIT |
| TypeScript6.0.3 | Type checking | Apache-2.0 |
| Playwright1.64.1 | Development browser checks | Apache-2.0 |

Exact transitive versions are pinned in package-lock.json. Review bundled
LICENSE/NOTICE files and component changes before redistribution; this list is
not a substitute for package-specific obligations.
