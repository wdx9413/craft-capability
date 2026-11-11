# craft-eval

This capability is a standalone repository at the workspace root: `../craft-eval`.

It is intentionally NOT a package inside `craft-capability`, because Craft Eval is an
independent evaluation suite with its own release lifecycle and must not depend on Craft
core. The evaluation scripts and their dependencies live in `craft-eval/src/`.

See `craft-eval/README.md` for build and test commands.
