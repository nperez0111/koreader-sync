# Agent Notes

## Releases

- `bumpp` can be run non-interactively with `--yes` (`-y`) to skip confirmation and `--release <type>` to specify the version bump (e.g. `bumpp --yes --release patch`).
- The release script in package.json is: `bumpp && gh release create v$(bun -e "const p = require('./package.json'); process.stdout.write(p.version)") --generate-notes`
- To run a full non-interactive release: `bumpp --yes --release patch && gh release create v$(bun -e "const p = require('./package.json'); process.stdout.write(p.version)") --generate-notes`
