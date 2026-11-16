# @craft/capability-file-dir-desc

A self-evolving registry of **places**: a directory on a named device, plus the human
name people use for it.

A place is `(device_id, path)`. The same absolute path on two machines is two places —
that is why the device dimension exists. A place may carry a repository identity
(remote URL + commit) when the directory is a git checkout; that identity is the only
thing that lets two devices recall the same checkout.

Part of the [Craft](https://github.com/wdx9413/craft) agent work runtime. This package is consumed by the Craft core and can also be used standalone.

## Usage

```ts
import { FileDirDescRegistry } from "@craft/capability-file-dir-desc";
import { CraftStore } from "craft-common-store-local";

const store = await new CraftStore(craftPaths()).open();
const registry = new FileDirDescRegistry(store);

// Record a place on a specific device
registry.record({
  device_id: "build-01", device_kind: "ssh",
  path: "/srv/billing", description: "billing service monorepo",
  repo_identity: { remote_url: "https://github.com/acme/billing.git" },
});

// Resolve a description back to places (device-scoped by default)
const result = registry.resolve({ description: "billing service" });

// Cross-device recall only through a repository identity
registry.resolve({ description: "billing service",
  repo_identity: { remote_url: "https://github.com/acme/billing.git" } });
```

## Device kinds

`local`, `ssh`, `container`, `remote-workspace`, `cloud`. Container and CI identities
are unstable by nature; record them only when the mount and device name are stable.

## Device metadata

A device is a first-class record, not just a string on a place. Register it before
recording its places so recall can respect device status and health:

```ts
registry.registerDevice({ id: "build-01", name: "CI builder", device_kind: "ssh",
  host_kind: "cloud", location: "eu-west", tags: ["ci", "build"], health: "healthy" });
registry.reportDeviceHealth("build-01", "healthy");
registry.disableDevice("build-01"); // its places stop being recallable, audit trail survives
registry.enableDevice("build-01");
registry.listDevices({ status: "active" });
```

Places carry non-identity `concept_kind` and `rationale` metadata from the shared
taxonomy, so context assembly can explain why a directory matters. `canonicalizePath`
exposes the same path normalization the registry uses, so callers can compare paths
without splitting one directory into two places. Disabled devices cannot gain new
places and are excluded from recall; re-enabling is deliberate.

## License

MIT
