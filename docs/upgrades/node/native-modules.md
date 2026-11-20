# Handling native modules when upgrading Node

Native (addon) modules contain compiled C/C++ code. They are tied to the Node **ABI** (`NODE_MODULE_VERSION`), so a binary built for Node 16 will not load on Node 22/24 (`Error: The module was compiled against a different Node.js version`). Pure-JS packages are unaffected.

This repo currently has **no native dependencies** (`bcryptjs`, `ws`, `ioredis`, `mongodb`, `jsonwebtoken` are pure JS; `ws` can optionally use `bufferutil`/`utf-8-validate`). If your fork adds some (e.g. `bcrypt`, `sharp`, `argon2`, `node-canvas`, `sqlite3`, `snappy`, `kerberos`), follow this.

## 1. Find them

```bash
# packages with a binding.gyp, .node files or install scripts
find node_modules -name "*.node" -not -path "*/test/*" | head -50
find node_modules -maxdepth 3 -name binding.gyp
npm ls --all --parseable 2>/dev/null | xargs -I{} sh -c 'grep -l "\"install\"\|gypfile\|node-gyp\|prebuild" {}/package.json 2>/dev/null'
npm explain node-gyp 2>/dev/null
```

Make a table: package, current version, who depends on it, whether it ships **prebuilt binaries** (prebuildify / `@mapbox/node-pre-gyp` / N-API) or compiles on install.

## 2. Pick the cheapest option per package

| Option | When | Example |
|---|---|---|
| **Replace with a pure-JS / WASM equivalent** | Perf is acceptable | `bcrypt` -> `bcryptjs` (already used here); `sqlite3` -> `node:sqlite` (built into Node 22.5+) |
| **Upgrade to a release with prebuilt binaries for the new Node** | Most maintained packages | `sharp`, `argon2`, `bcrypt` >= 5.1, `bufferutil` |
| **N-API (Node-API) packages** | ABI-stable: one binary works across Node majors, usually no rebuild | prefer these when choosing |
| **Compile from source** | No prebuild exists | needs a toolchain (below) |
| **Drop** | It is an unused/optional dependency | `bufferutil`, `utf-8-validate` are optional for `ws` |

Check each package's changelog for "Node 24/22 support" before upgrading.

## 3. Rebuild on the new Node

Always rebuild with the **target** Node active, never copy `node_modules` between versions.

```bash
nvm use 24                      # target LTS
rm -rf node_modules
npm ci                          # runs install scripts, fetches prebuilds or compiles
# if a package was installed earlier and only needs recompiling:
npm rebuild                     # or: npm rebuild bcrypt --build-from-source
```

Build toolchain, only needed when compiling:

| OS | Install |
|---|---|
| macOS | `xcode-select --install` |
| Debian/Ubuntu | `apt-get install -y build-essential python3 make g++` |
| Alpine (our `node:*-alpine` images) | `apk add --no-cache python3 make g++` |
| Windows | Visual Studio Build Tools ("Desktop development with C++") |

`node-gyp` needs Python 3 and a C++17 compiler for recent Node versions. Old `node-gyp` (<9) fails on Node 22+; upgrade the package (which bumps its `node-gyp`) rather than patching.

## 4. Docker (the usual pain point)

Rules:

1. **Install and build inside the image** for the same Node version and **same OS/libc** you run on. Never copy a `node_modules` built on a Mac into a Linux image.
2. **Alpine uses musl**, Debian/Ubuntu use glibc. Many prebuilt binaries are published for both, but some only for glibc. If a package fails on Alpine either install the toolchain or use `node:24-slim` (Debian).
3. Use a **multi-stage build**: compile in a builder stage, copy only `node_modules` into the runtime stage so build tools stay out of the final image.

```dockerfile
FROM node:24-alpine AS deps
RUN apk add --no-cache python3 make g++     # only if something compiles
WORKDIR /app
COPY package*.json ./
COPY packages/*/package.json packages/ ...   # keep the workspace layout
RUN npm ci --omit=dev

FROM node:24-alpine
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
CMD ["node", "services/game/src/index.js"]
```

Same architecture too: building on Apple Silicon for an x86 server needs `--platform=linux/amd64` (or build in CI).

## 5. CI and deployment

- CI runs `npm ci` on the **same Node major and OS** as production.
- Cache by Node version: use `node-version` + lockfile hash as the cache key so you never restore binaries built for another Node.
- Do not commit `node_modules` or `build/` folders.
- Pin the Node version (`.nvmrc`, `engines`, Docker tag) so a native build never silently changes.

## 6. Test native paths explicitly

`npm test` may not exercise the addon. Add a quick check per native package:

```bash
node -e "require('bcrypt').hashSync('x',10); console.log('bcrypt ok')"
node -e "import('sharp').then(m=>console.log('sharp', m.default.versions))"
```

Then run `npm run smoke`, and load-test hot paths (hashing, image processing) because performance can differ between builds.

## 7. Troubleshooting

| Error | Cause / fix |
|---|---|
| `compiled against a different Node.js version (NODE_MODULE_VERSION 93...)` | Stale binary: `rm -rf node_modules && npm ci` on the new Node |
| `gyp ERR! find Python` | Install Python 3, or `npm config set python python3` |
| `gyp ERR! ... g++ not found` / `make: not found` | Install the toolchain (section 3) |
| `Error loading shared library ... musl / glibc` | Alpine vs Debian mismatch: switch the base image or rebuild from source |
| `prebuild-install WARN ... No prebuilt binaries found` | Package has no binary for this Node/OS yet: upgrade it, or install toolchain and build, or replace it |
| Works locally, fails in Docker | Host `node_modules` copied into the image: add `node_modules` to `.dockerignore` |
| `EBADPLATFORM` / wrong CPU | Build for the right `--platform` |

## Checklist

- [ ] Native packages listed (with versions and prebuild status)
- [ ] Each one upgraded, replaced, or confirmed to build on the target Node
- [ ] `rm -rf node_modules && npm ci` clean on the target Node and in Docker
- [ ] Build tools only in the builder stage; `node_modules` in `.dockerignore`
- [ ] CI cache keyed by Node version
- [ ] Per-package smoke checks plus `npm test` and `npm run smoke` green
