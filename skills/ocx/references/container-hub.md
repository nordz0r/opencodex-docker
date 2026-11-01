# Operating a Container Hub (Docker Compose / Kubernetes)

This document extends the upstream `ocx` skill for hubs packaged as containers
and run in Docker Compose or Kubernetes. It is a **local extension**; upstream
skill updates must not overwrite or delete it.

## Scope

- The hub runs in Docker Compose or Kubernetes, typically from a custom
  multi-stage image, non-root, with dual home directories. Do not assume which
  home holds state or configuration.
- CLI availability, binary name, and path inside the container are **not
  guaranteed**. Verify before use; never assume `ocx` is on `PATH` or that a
  specific absolute path exists.
- Upstream guidance still applies: CLI help is offline; ordinary client
  management commands do **not** automatically target the remote hub;
  readiness/version checks are separate from mutation; no access-key creation or
  invites inside an agent session; mutations must be read back.

## Runtime CLI vs local client

- A **runtime CLI** executes inside the hub container/pod and can act on that
  hub's state.
- A **local client** executes on your machine and only reaches the hub if
  explicitly configured to do so. Do not assume local commands affect the remote
  hub.
- Always state which one you are invoking and why.

## Safe runtime discovery (read-only)

Discover before acting. Prefer read-only commands and avoid assuming names.

```sh
# Compose: list services and running state (read-only)
docker compose ps

# Kubernetes: list pods for the target namespace (read-only)
kubectl get pods -n <NAMESPACE> -l <LABEL_SELECTOR>

# Identify the container to exec into (read-only)
docker compose config --services
kubectl get pod <POD> -n <NAMESPACE> -o jsonpath='{.spec.containers[*].name}'
```

Then confirm CLI presence without assuming the path:

```sh
# Compose: check CLI availability inside the service
docker compose exec -T <SERVICE> sh -lc 'command -v ocx || command -v <ALT_BIN> || echo "ocx not found"'

# Kubernetes: same, explicit namespace and container
kubectl exec -n <NAMESPACE> -c <CONTAINER> <POD> -- sh -lc 'command -v ocx || command -v <ALT_BIN> || echo "ocx not found"'
```

If the binary is absent or the path is unknown, report that as an unknown rather
than guessing an absolute path or inventing flags.

## Explicit selection

- **Compose:** always name the service; use `-T` to disable TTY allocation for
  non-interactive, scripted use.
- **Kubernetes:** always specify `-n <NAMESPACE>` and `-c <CONTAINER>`; do not
  rely on defaults or context.
- Use portable placeholders (`<NAMESPACE>`, `<POD>`, `<SERVICE>`,
  `<CONTAINER>`, `<ALT_BIN>`) — never real namespaces, hosts, personal paths, or
  secrets.

## Health, logs, and version (read-only examples)

```sh
# Compose: readiness/version and recent logs
docker compose exec -T <SERVICE> sh -lc 'ocx --version'
docker compose logs --tail=100 <SERVICE>

# Kubernetes: readiness/version and recent logs
kubectl exec -n <NAMESPACE> -c <CONTAINER> <POD> -- sh -lc 'ocx --version'
kubectl logs -n <NAMESPACE> <POD> -c <CONTAINER> --tail=100
```

Treat version/readiness output as informational. Do not infer mutation success
from health alone.

## Desired state vs live changes

- Compose/Kubernetes manifests describe **desired state**; the running
  container/pod is **live state**. A manifest edit does not change the running
  hub until applied and reconciled.
- When asked to change configuration, clarify whether the intent is to edit
  desired-state files (and require a deliberate apply/restart) or to make a live
  change. Do not silently mutate live state to compensate for unapplied desired
  state.
- After any mutation, **read back** the resulting state and report actual vs
  intended.

## Secrets

- Never print, echo, or interpolate secrets (access keys, tokens, invite
  material). Do not create access keys or invites in an agent session; direct
  the user to the supported out-of-band process.
- If a command would require a secret, reference it by environment variable or
  secret reference name only; do not expand it into logs or transcripts.

## Unsupported flags and unknowns

- Do not invent or use `ocx` flags not confirmed by offline help or the upstream
  skill. If a needed capability is unclear, state the unknown and propose a
  read-only verification step instead.
- Do not assume config file locations, home directory usage, or state paths
  inside the container; confirm via discovery or report as unknown.

## Operating rules

1. Discover runtime and CLI availability before acting.
2. Name service/pod/container/namespace explicitly; use `-T` for Compose and
   `-c`/`-n` for Kubernetes.
3. Separate runtime CLI from local client.
4. Keep health/logs/version read-only; distinguish desired vs live state.
5. Read back every mutation; handle secrets only by reference; flag unknowns
   rather than guessing.
