# Craft Notes

`@craft/craft-notes` is the package identifier. The unified public capability is **Craft Notes** and stores typed Device, Directory and File notes in the existing Craft Store.

## Rules

- A device can be registered only with a user supplied Device Note. A disabled device can be re-enabled only after it has a confirmed Device Note.
- Directory and File Notes begin as pending candidates. A Notes-owned asynchronous qualification run rechecks device identity and usage evidence: three distinct completed tasks across at least two Host sessions in a rolling 30-day window, or an explicit pin. Qualification only makes the candidate eligible for human review; it never confirms it.
- File references are caller supplied. The capability never opens or reads a file. Optional size and modification time are review hints; missing remote metadata is recorded as `path_only`.
- Only confirmed Notes and migrated promoted legacy entries enter default retrieval. Revoked Notes stay out of retrieval.
- Credential-like note text is rejected. Notes are scoped by device, project and exact path.

## Example

```ts
import { CraftNotesRegistry } from "@craft/craft-notes";

const notes = new CraftNotesRegistry(store);
notes.createDevice({ id: "laptop", note: "主力开发机，运行本地模型" });

const candidate = notes.observeDirectory({
  path: "/work/billing",
  device_id: "laptop",
  project_id: "project:billing",
  task_id: "task-42",
  session_id: "codex-session-9",
  outcome: "completed",
});
// A durable worker may run this after the Host returns. It returns status and IDs only.
const qualification = notes.qualifyCandidates({ limit: 50 });
// A human must confirm the exact candidate before it is recalled by default.
```

`CraftNotesRegistry` manages typed notes. `CraftNotesLocationRegistry` manages directory locations and device metadata as part of the same Craft Notes package. New MCP operations use the `craft_notes_*` namespace.

## Compatibility API

Existing installations may contain directory locations in the `file_dir_desc` store collection. The package copies those rows idempotently to `craft_notes_location` on first open, preserving IDs, status and audit fields; all new reads and writes use the renamed collection. Device registration requires a user-authored `device_note`; re-enabling a disabled device requires a confirmed Device Note. Existing device kind, host kind, location, tags and health metadata remain supported.

Directory locations retain their `concept_kind` and `rationale` fields, repository identity, use count and revocation audit. Device, Directory and File Notes are exposed under the Craft Notes package.

## Device kinds

`local`, `ssh`, `container`, `remote-workspace` and `cloud` are supported. Container and CI identities are unstable; record them only when the mount and device name remain stable.

## License

MIT
