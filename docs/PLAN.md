# Plan — WeFaber Code Mode (WCM)

Objetivo: un paquete compartido, un estándar verificable y un gateway único; migrar `mcp.wefaber.net` y todos los repos con superficie de agente.

Estándar que implementa: `./SPEC.md` (v0.2).

Estimación total: **~53 h** de trabajo efectivo, en 9 fases. Cada fase termina en un PR revisable, no en un deploy.

Convenciones: `[P0]` urgente · `[P1]` alta · `[P2]` media · `[P3]` cuando haya tiempo.

---

## Fase 0 — Verificación (hecha, 2026-10-26)

Cerrada. Resultado en `DECISIONS.md`:

- D1 aceptada: `mcp.wefaber.net` = gateway, wegraf a `wegraph.wefaber.net`.
- D2 aceptada con tres adaptadores. El token de zona no permite leer el plan de Cloudflare por API, pero la doc confirma que Dynamic Workers requiere Workers Paid: se resuelve usando `quickjs` en VPS como default y `quickjs-wasm` dentro del Worker de wegraf.
- D3 aceptada: `kit` pasa a catálogo del gateway, stdio generado.

Pendiente único, no bloqueante: **confirmar el plan de Workers en el dashboard** (Workers & Pages → Overview). Solo cambia si algún día se habilita `dynamic-workers`; hoy no hace falta.

---

## Fase 1 — Repo y paquete `@wefaber/codemode` (10 h) [P0]

Repo nuevo: `wefaber/codemode` (privado, Bun + TypeScript).

```
packages/core/src/{registry,spec,errors,limits,run}.ts
packages/sandbox-quickjs/src/{qjs,worker,exec,sandbox}.ts
packages/sandbox-quickjs-wasm/src/sandbox.ts   # se implementa en Fase 4 (wegraf)
packages/mcp/src/{handler,protocol,run,limiter}.ts   # el limiter vive acá: es del transporte, no del sandbox
packages/cli/src/index.ts
tests/conformance/
docs/SPEC.md
```

### Task 1.1 — Crear repo y esqueleto de workspace (45 min)

```bash
gh repo create wefaber/codemode --private --description "Code Mode toolkit: registry, sandbox, MCP handler and gateway" --clone
cd ~/repos/codemode && bun init -y
```

`package.json` con workspaces `packages/*`; `tsconfig.json` estricto; `oxlint` + `oxfmt` como el resto de los repos.

**Verificación**: `bun install && bun run check` en verde con el repo vacío.

### Task 1.2 — `defineOp` y el registry (1 h 30)

**Crear**: `packages/core/src/registry.ts`
Copia el contrato de `mychecklist/services/registry.ts` si existe; si no, es esto: `defineOp({ id, scope, summary, input, output, handler })` con TypeBox, validación de que el `id` matchea `^[a-z]+\.[a-z]+\.[a-z]+$` y que el verbo está en el conjunto cerrado (SPEC R4). `createRegistry(ops)` indexa por id y detecta duplicados al construir.

**Test**: `registry.test.ts` — id inválido lanza; id duplicado lanza; verbo fuera del conjunto lanza.

**Verificación**: `bun test packages/core` → 3 passed.

### Task 1.3 — Generador de spec y de tipos (2 h)

**Crear**: `packages/core/src/spec.ts`
`buildSpec(registry)` → `{ version, product, ops: [{ id, scope, summary, input, output }] }` serializando TypeBox a JSON Schema. `emitDts(spec)` → `client.d.ts` con un namespace por recurso: `codemode.checklist.items.create(input): Promise<Output>`.

**Crear**: `packages/core/src/cli.ts` — `bun run gen` escribe `spec.json` y `client.d.ts`; `bun run check` compara y falla con `spec.json desactualizado, corriste gen?`.

**Verificación**: en un producto de prueba, agregar una op nueva y correr `check` → falla; `gen` → pasa. Commit de ambos archivos.

### Task 1.4 — Sandbox QuickJS extraído (2 h)

**Crear**: `packages/sandbox-quickjs/src/sandbox.ts`
Es `mychecklist/server/mcp/sandbox.ts` tal cual (284 líneas ya probadas: límites, host namespaces, dump de handles, pumping de jobs). Le cambia solo el import y se le agrega la interfaz `Sandbox`.

**Crear**: `packages/sandbox-quickjs/src/worker.ts` — el `Bun Worker` que envuelve la corrida y permite `terminate()` (SPEC §5).

**Test**: los 6 tests de escape + timeout + maxCalls + memoria.

**Verificación**: `bun test packages/sandbox-quickjs` → 10 passed, incluido el caso `"x".repeat(1e6)` que corta por `terminate()` y no por interrupt handler.

### Task 1.5 — Handler MCP `search` + `execute` (1 h 30)

**Crear**: `packages/mcp/src/handler.ts`
`createWcmHandler({ product, registry, sandbox, auth, audit })` devuelve un handler HTTP que atiende `POST /mcp` (Streamable HTTP) con exactamente dos tools, y `POST /codemode/{search,execute}` (SPEC §6). `search` inyecta `spec` en el sandbox y no autentica. `execute` resuelve token → scopes → host con wrapper de scope → corre → audita.

**Verificación**: contra un registry de prueba, `tools/list` devuelve exactamente `["search","execute"]`.

### Task 1.6 — CLI stdio (1 h)

**Crear**: `packages/cli/src/index.ts` — `bunx @wefaber/codemode-cli --url https://producto/ --token ...` habla MCP por stdio y reenvía a `/codemode/*`. Sirve para agentes locales sin gateway.

**Verificación**: `echo '{"jsonrpc":"2.0",...}' | bunx ... | jq` responde `initialize` y lista dos tools.

---

## Fase 2 — `mychecklist` consume el paquete (3 h) [P0]

mychecklist ya tiene Code Mode en producción (M5, ADR 0002 y 0007): 19 ops, registry con `defineOp`, sandbox QuickJS en
Worker, `search` + `execute`, tokens `mck_`. La fase no porta nada: cambia el origen del código por `@wefaber/codemode*`
y alinea el contrato al SPEC. Es el producto que valida el estándar antes de tocar wegraf.

### Task 2.1 — Reemplazar el código local por los paquetes (1 h)

**Borrar**: `server/mcp/{sandbox,worker,exec,limiter,protocol,codemode,spec}.ts` y sus tests (viven en el paquete).
**Modificar**: `server/mcp/routes.ts` queda como adaptador fino que monta `createWcmHandler` con `auth` (`findApiToken`,
`touchApiToken`, `openScope`) y `audit` (tabla `activity`, `via=mcp`).

**Verificación**: `bun test` sin cambiar aserciones de `codemode.test.ts`, `codemode.auth.test.ts`, `isolation.test.ts`.

### Task 2.2 — Alinear el registry al SPEC (1 h 30)

**Modificar**: `server/services/registry.ts` — `name`→`id` (`checklist.<recurso>.<verbo>`), `mode`→`scope`; las ops con
verbo fuera del conjunto base (`rename`, `setDone`, `updateText`, `backlinks`) llevan `verbException`. El host expone
`codemode.checklist.*` y el alias `checklist.*` durante una minor. `spec.version` pasa a `"1.0.0"`.

**Verificación**: `wcm check` en verde con `spec.json` y `checklist.d.ts` regenerados y commiteados.

### Task 2.3 — Scope y auditoría (30 min)

Token `read` contra `items.create` → `FORBIDDEN`; la corrida deja fila con `error_code=FORBIDDEN`.

### Task 2.4 — Merge (no se deploya a mano)

Branch `feat/wcm-toolkit`, PR, CI verde, revisión. El deploy corre por el workflow del repo.

**Criterio de salida de fase**: mychecklist cumple el Definition of Done completo de SPEC §12.

---

## Fase 3 — Suite de conformidad (4 h) [P1]

Una sola suite que cualquier producto corre para probar que cumple el estándar. Es lo que evita que cada migración invente su propia interpretación.

**Crear**: `tests/conformance/` en el repo `codemode`, publicado como `@wefaber/codemode-conformance`.

Tests que exporta: `runConformance({ baseUrl, token })` verifica
1. `/mcp` publica exactamente dos tools;
2. `tools/list` no filtra esquemas de operaciones;
3. `search` devuelve solo lo pedido;
4. `execute` con código vacío devuelve `null`;
5. timeout con `await new Promise(()=>{})` → `TIMEOUT`;
6. `fetch` dentro del sandbox lanza;
7. token `:read` en op `:write` → `FORBIDDEN`;
8. toda corrida deja fila de auditoría;
9. `spec.version` presente y parseable;
10. dos llamadas en un `execute` hacen `calls=2`.

**Verificación**: corre verde contra `mychecklist` y rojo contra el `wegraph` actual (que aún publica 23 tools).

---

## Fase 4 — `mcp.wefaber.net`: wegraf de 23 tools a 2 (6 h) [P0]

### Task 4.1 — Mudar el worker a `wegraph.wefaber.net` (1 h)

**Modificar**: `wegraph/deployments/wefaber.wrangler.jsonc` — `routes` pasa de `mcp.wefaber.net` a `wegraph.wefaber.net`; DNS CNAME en la zona (según la arquitectura de subdominios: CNAME al apex). `workers_dev: false` se mantiene.

**Verificación**: `curl -s -o /dev/null -w "%{http_code}" https://wegraph.wefaber.net/health` → 200; `mcp.wefaber.net` queda libre para el gateway.

### Task 4.2 — Registry de wegraf (3 h)

**Crear**: `wegraph/server/core/registry.ts`
Las 23 tools de `server/core/mcp.ts` se reescriben como ops. Se agrupan por recurso: `wegraph.org.*`, `wegraph.graph.*`, `wegraph.docs.*`, `wegraph.eval.*`, `wegraph.scaffold.*`, `wegraph.telemetry.*`. Los handlers siguen llamando a `svc.*` (no se reescribe la lógica). Las ops con efecto (`propose_update`, `confirm_update`, `publish_doc`, `scaffold_project`) mantienen su par propose/confirm y declaran `wegraph:write`.

**Verificación**: `bun run gen` produce spec con 23 ops y 0 duplicados.

### Task 4.3 — Reemplazar el handler MCP (1 h)

**Modificar**: `wegraph/worker/index.ts` — `/mcp` pasa de `server/core/mcp.ts` a `createWcmHandler`. Se conserva `/health`, `/ready`, `/api/*` y el bearer `MCP_AUTH_TOKEN` como token de compatibilidad con scope `wegraph:admin`.

**Verificación**: `curl -s -X POST https://wegraph.wefaber.net/mcp -H "Authorization: Bearer $MCP_AUTH_TOKEN" ... tools/list` → `["search","execute"]`; una corrida real de `resolve_context` vía `execute` devuelve lo mismo que antes.

### Task 4.4 — Conformidad y PR (1 h)

`runConformance` verde contra `wegraph.wefaber.net`. PR con el antes/después de tokens del tool list (medir: `wc -c` del JSON de `tools/list` viejo vs nuevo).

**Criterio de salida**: wegraf cumple DoD; `mcp.wefaber.net` ya no tiene worker.

---

## Fase 5 — Gateway (8 h) [P0]

### Task 5.1 — Servicio `codemode-gateway` en el VPS (2 h)

**Crear**: `apps/gateway/src/index.ts` — servicio Bun (Elysia), sin dominio. Rutas `/mcp`, `/codemode/search`, `/codemode/execute`, `/health`, `/catalog`.
**Crear**: `~/deploy/services/codemode-gateway.service` (systemd, user `hermes`, `bun /srv/codemode/current/apps/gateway/src/index.ts`), vhost Nginx en `127.0.0.1:4171`, deploy blue/green con symlink `current` como el resto.

**Verificación**: `curl -s 127.0.0.1:4171/health` → `{"ok":true}`.

### Task 5.2 — Catálogo (2 h)

Los `spec.json` de cada producto se publican en el catálogo (tabla SQLite propia o archivos versionados en `/srv/codemode/catalog/`), con `producto → { major, url, scopes }`. `search` corre el código contra el catálogo completo dentro del mismo sandbox `quickjs` de Fase 1.

**Verificación**: `search` con código que filtra `items` devuelve solo ops de checklist, y el response pesa menos de 2 KB.

### Task 5.3 — Router `execute` (2 h 30)

Prefijo `codemode.<producto>.*` → fetch a `<url>/codemode/execute` con identidad firmada HMAC (`x-wcm-token-hash`, `x-wcm-scopes`, `x-wcm-via: gateway`). Presupuesto global por token en SQLite del gateway (el gateway vive en el VPS, SPEC §8). Producto caído → `PRODUCT_UNAVAILABLE`.

**Verificación**: un `execute` que toca dos productos distintos en la misma corrida devuelve el resultado combinado, y cada producto ve su `run_id` en la auditoría.

### Task 5.4 — DNS y corte (1 h 30)

`mcp.wefaber.net` pasa a proxied (naranja) en Cloudflare apuntando al VPS, con vhost Nginx y cert. El token existente sigue funcionando: el gateway lo valida contra el catálogo y lo reenvía firmado.

**Verificación**: `curl https://mcp.wefaber.net/health` → 200; conformance verde contra el gateway; el mismo `code` que antes funcionaba contra wegraf ahora funciona contra el gateway sin cambios.

**Criterio de salida**: un agente (Hermes) conectado a `mcp.wefaber.net` usa checklist y wegraf con un solo token.

---

## Fase 6 — `kit`, `ohmydocs`, `ohmydiagrams` (10 h) [P1]

### Task 6.1 — `kit` como catálogo (2 h)

`kit/mcp/src/index.ts` (4 tools stdio) pasa a registry + op. El catálogo se sirve por el gateway; el stdio se genera con `@wefaber/codemode-cli` para Claude Code.

**Verificación**: `get_standard` vía `execute` del gateway devuelve el mismo markdown que la tool stdio.

### Task 6.2 — `ohmydocs` (4 h)

**Crear**: `ohmydocs/mcp-server/src/registry.ts`. Sus 4 grupos (documents, branding, templates, context) se convierten en ops. Los "resources" de dominio (documentación legible) se mueven a una op `ohmydocs.docs.read` — un resource MCP no encaja en Code Mode.

**Verificación**: conformance verde contra el endpoint del producto.

### Task 6.3 — `ohmydiagrams` (4 h)

11 tools + OAuth propio + bridge de canvas. Lo delicado es el bridge: los handlers siguen hablando con `CanvasBridge` (no puede pasar por el sandbox porque toca el DOM). El bridge queda del lado host; el sandbox solo lo invoca.

**Verificación**: crear un diagrama con `codemode.ohmydiagrams.diagrams.create(...)` en una corrida que además lo valide con `...checklist.validate(...)`, en menos de 5 s.

---

## Fase 7 — Productos VPS sin MCP (8 h) [P2]

`jobit`, `mercuria`, `lux`, `cdn-panel`, `wepanel`, `files`. No tienen MCP: tienen REST o GraphQL. Para estos, el patrón es **search + execute sobre OpenAPI** sin escribir registry a mano:

1. Exportar el OpenAPI del producto (Elysia lo genera; GraphQL queda fuera por ahora).
2. `spec` derivado del OpenAPI, corriendo en el adaptador `quickjs` (D2: los productos del VPS no usan Workers).
3. Scope por grupo de rutas, auth por token del producto.
4. Conformance.

Prioridad dentro de la fase: `jobit` (API Bun :3200, ya separada del front) → `mercuria` (GraphQL :3011, necesita capa de ops manual) → `lux` (:4111/4112) → `cdn-panel` (tailnet, solo lectura) → `files` (:8788).

**Verificación por producto**: una corrida de ejemplo documentada en el README del producto.

---

## Fase 8 — Observabilidad y cierre (4 h) [P1]

### Task 8.1 — Tablero de uso (2 h)

Vista en `wefaber/wefaber-status` o panel aparte: ops por producto, errores por código, p95, tokens por agente. Datos de `run_id`/auditoría.

### Task 8.2 — Skill y documentación (2 h)

**Crear**: skill `wefaber-codemode` con: cómo agregar una op, cómo correr conformance, cómo publicar en el catálogo, y los tres errores que vas a cometer (spec a mano, fetch en el handler, tool por operación). Actualizar `wefaber-mcp` para que apunte al gateway y no a wegraf.

---

## Orden recomendado de ejecución

```
Fase 0 (1 h) → Fase 1 (10 h) → Fase 2 (8 h) → Fase 3 (4 h)
      → Fase 4 (6 h) → Fase 5 (8 h)   ← acá mcp.wefaber.net ya es Code Mode
      → Fase 6 (10 h) → Fase 8 (4 h) → Fase 7 (8 h)
```

Fase 8 antes de Fase 7 a propósito: la observabilidad sirve para medir la migración de los VPS, y sin ella Fase 7 es a ciegas.

---

## Riesgos

| Riesgo | Mitigación |
|---|---|
| `worker_loaders` no disponible (plan Free) | `quickjs` es el default; el adaptador `workers` se difiere |
| QuickJS cuelga el event loop con builtins grandes | Worker terminable obligatorio (ya medido: 12 s vs deadline 2 s) |
| Mudanza de `mcp.wefaber.net` rompe clientes existentes | Período de convivencia: wegraf sigue respondiendo en `wegraph.wefaber.net` con el mismo token |
| Cada producto interpreta el estándar distinto | La suite de conformidad es el árbitro, no el documento |
| Migración a medias (dos APIs vivas) | El DoD exige borrar el handler MCP viejo en el mismo PR |
| Tokens globales compartidos | Scope por agente desde el día uno; token `admin` solo para operador |
