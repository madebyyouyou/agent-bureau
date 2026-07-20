# Third-Party Notices

## CliDeck

`vendor/clideck/` is a source reference snapshot of CliDeck v1.31.24 used for integration analysis and patch regression tests. Two unreferenced upstream demo GIFs were omitted from this portfolio snapshot to avoid adding 13.5 MB of unused binary data; source and runtime files are otherwise retained.

- Project: [CliDeck](https://github.com/rustykuntz/clideck)
- Version: 1.31.24
- Copyright: Copyright (c) 2025 Or Kuntzman
- License: MIT; the full text is retained at [`vendor/clideck/LICENSE`](vendor/clideck/LICENSE)

The vendored snapshot includes CliDeck source code, documentation, UI assets, icons, images, and notification sounds distributed with that upstream version. Those files remain subject to the upstream license and notices. Product names and logos used for identification may also be trademarks of their respective owners; no endorsement is implied.

CliDeck declares the following runtime dependencies in its package manifest; they are not copied into this repository as `node_modules`:

- `@xterm/addon-fit` — MIT
- `@xterm/xterm` — MIT
- `node-pty` — MIT
- `ws` — MIT

## Feather Icons

The inline SVG symbols used by the Agent Bureau UI and HTML design prototypes include icons from [Feather Icons](https://github.com/feathericons/feather).

The MIT License (MIT)

Copyright (c) 2013-2023 Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Repository licensing

Except for files under `vendor/clideck/` and any file carrying its own notice, the original Agent Bureau code and design materials are copyright © 2026 YouYou. Publication as a portfolio snapshot does not grant a license to copy, modify, or redistribute those original portions.
