# Craft Notes

`@craft/capability-file-dir-desc` remains the package identifier for compatibility. The unified public capability is **Craft Notes** and stores typed Device, Directory and File notes in the existing Craft Store.

## Rules

- A device can be registered only with a user supplied Device Note. A disabled device can be re-enabled only after it has a confirmed Device Note.
- Directory and File Notes begin as candidates. Three distinct completed tasks across at least two Host sessions in a rolling 30-day window qualify a candidate; an explicit pin can also create one. Neither path confirms it automatically.
- File references are caller supplied. The capability never opens or reads a file. Optional size and modification time are review hints; missing remote metadata is recorded as `path_only`.
- Only confirmed Notes and migrated promoted legacy entries enter default retrieval. Revoked Notes stay out of retrieval.
- Credential-like note text is rejected. Notes are scoped by device, project and exact path.

## Example

```ts
import { CraftNotesRegistry } from "@craft/capability-file-dir-desc";

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
// A human must confirm the exact candidate before it is recalled by default.
```

The previous `FileDirDescRegistry` and `craft_file_dir_desc_*` names remain compatibility surfaces. New integrations should use `CraftNotesRegistry` and `craft_notes_*` operations.

## Compatibility API

`FileDirDescRegistry` and the existing `craft_file_dir_desc_*` operations remain available for legacy place records. Device registration through this API also requires a user-authored `device_note`; re-enabling a disabled device requires a confirmed Device Note. Existing device kind, host kind, location, tags and health metadata remain supported.

Legacy directory records retain their `concept_kind` and `rationale` fields, repository identity, use count and revocation audit. New integrations that manage Device, Directory and File Notes should use `CraftNotesRegistry`; the older registry remains for compatibility with existing place records.

## Device kinds

`local`, `ssh`, `container`, `remote-workspace` and `cloud` are supported. Container and CI identities are unstable; record them only when the mount and device name remain stable.

## License

MIT
