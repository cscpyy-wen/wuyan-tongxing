# Upstream and local changes

This workspace-local compatibility package is a security-hardened adaptation of
[`git-clone`](https://github.com/jaz303/git-clone), originally licensed under
the ISC License by Copyright (c) 2014-2021 Jason Frame & Contributors.

The local implementation is intended as a compatible replacement for the
unmaintained upstream package. Its high-level security and reliability changes
include:

- validation of remote URLs, refs, and executable inputs;
- child-process execution with `shell: false`;
- an explicit `--` option terminator before positional Git arguments; and
- single-callback completion semantics.

See `LICENSE` in this directory for the applicable ISC License.
