# WeFaber Code Mode (WCM) — Estándar y Arquitectura

Estado: propuesta v0.1 — 2026-10-26
Autor: Ether
Alcance: todo producto de wefaber, faku-org, ohmyapps-org, adastra-org que exponga capacidades a un agente.

---

## 1. Problema

Cada producto resuelve su interfaz de agente por su cuenta:

| Superficie | Transporte | Auth | Tools |
|---|---|---|---|
| `wegraph` (mcp.wefaber.net) | Streamable HTTP en CF Worker | Bearer `MCP_AUTH_TOKEN` único | 24 |
| `kit` | stdio (Bun) | ninguna | 4 |
| `ohmydiagrams` | HTTP + bridge + OAuth propio | OAuth | 11 |
| `ohmydocs` | MCP embebido en la app | propia | 4 grupos |
| `mychecklist` | diseñado, no implementado (ADR 0002) | Bearer sha256 por agente | 2 (plan) |
| jobit, mercuria, lux, cdn-panel, wepanel, files | sin MCP | — | — |

Consecuencias medidas:

1. **Costo de contexto**: 24 tools de wegraf son varios miles de tokens de esquemas que se pagan en cada sesión, se usen o no.
2. **Round-trips**: `resolve_context → query_org_graph → trace_node` son tres idas al modelo para un solo razonamiento. Cada resultado intermedio vuelve al contexto completo.
3. **Inconsistencia**: cuatro formas de autenticar, tres transportes, cero auditoría común. Un agente nuevo tiene que aprender cada servidor.
4. **Duplicación**: cada producto reimplementa validación, límites, paginación y manejo de errores.

**Objetivo**: una sola forma de exponer un producto a un agente, con un paquete compartido, un gateway único y un contrato verificable.

---

## 2. Qué es Code Mode

El cliente MCP ve **como máximo dos herramientas**: `search` y `execute`. Adentro corre código JavaScript escrito por el modelo contra una API tipada del producto. El código encadena llamadas, filtra, agrega y devuelve solo el resultado final. Los datos intermedios nunca entran al contexto del modelo.

Dos patrones (Cloudflare, ya implementados en `@cloudflare/codemode` 0.5.5):

- **single code tool** (`code`): el producto tiene un set acotado de operaciones; las definiciones TypeScript viajan en la descripción de la tool.
- **search + execute**: catálogo grande o API OpenAPI externa; `search` corre código contra el spec y devuelve solo las operaciones necesarias, `execute` corre contra el request autenticado.

WCM usa **`search` + `execute` como forma canónica** para todos los productos, porque el spec de cualquier producto puede crecer y porque el gateway necesita un contrato uniforme para enrutar. El patrón `code` queda permitido solo para servidores locales de un solo producto con menos de 10 operaciones.

Lo que Code Mode **no** es:

- No es un reemplazo de la API del producto. Es una forma de invocar los mismos servicios.
- No es un sandbox de seguridad perimetral. El sandbox protege el proceso del host, no autoriza: la autorización vive en las operaciones.
- No elimina la necesidad de MCP. Lo usa como transporte delgado.

---

## 3. Las doce reglas

RFC 2119: **DEBE** = obligatorio, **DEBERÍA** = default con excepción justificada en el ADR del producto.

**R1 — Un registry por producto.** Toda operación expuesta a agentes se declara una sola vez con `defineOp()`. No se registran tools a mano. El registry es la única fuente de la API de agentes.

**R2 — Dos herramientas, no más.** El endpoint MCP publica `search` y `execute`. Publicar tools individuales es una regresión de diseño.

**R3 — Las operaciones llaman al service layer existente.** Una operación no habla con la base ni con HTTP externo por su cuenta: llama al mismo servicio que usa GraphQL/REST. El sandbox no tiene red.

**R4 — Nombres `producto.recurso.verbo`.** Verbo de un conjunto cerrado: `list`, `get`, `create`, `update`, `delete`, `search`, `run`. Dentro del sandbox: `codemode.checklist.items.create(...)`. Sin abreviaturas, sin nombres de tabla.

**R5 — Scopes explícitos.** `producto:read`, `producto:write`, `producto:admin`. Cada operación declara el suyo. Las de efecto (`create/update/delete/run`) DEBEN declarar `write` o superior. Un token sin scope recibe `FORBIDDEN`, nunca un resultado vacío.

**R6 — Límites con techo.** Default: 5 s de reloj, 64 MB de memoria, 50 llamadas al host, 64 KB de resultado, 200 líneas de consola, 512 KB de stack. Configurables, nunca ausentes. El deadline duro lo aplica un worker terminable, no el interrupt handler del intérprete.

**R7 — Resultado mínimo.** La operación devuelve lo necesario para decidir, no la fila entera. `execute` trunca con marcador `--- TRUNCATED ---` en vez de cortar silenciosamente.

**R8 — Spec con semver.** `spec.json` lleva `version`. Cambiar la firma de una operación es breaking = major. El gateway pinnea versión por producto y rechaza `execute` contra una major que no conoce.

**R9 — Credenciales fuera del sandbox.** El código recibe una función de request o un namespace ya autenticado. Nunca un token, una URL con secreto ni un header. Los tokens se guardan hasheados (sha256) por agente.

**R10 — Auditoría por corrida.** Cada `execute` deja una fila: producto, token, operaciones llamadas, ms, bytes de resultado, código de error. Sin esto no hay forma de saber qué hizo un agente ni de cobrar cuota.

**R11 — Generación verificable.** `spec.json` y `client.d.ts` se generan del registry. `bun run check` falla si están desactualizados. Un spec editado a mano es un bug de CI, no un atajo.

**R12 — Errores con código, sin stack.** `TIMEOUT`, `TOO_MANY_CALLS`, `CODE_ERROR`, `HOST_ERROR`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION`. El modelo recibe el código y un mensaje accionable; el stack queda en el log del servidor.

---

## 4. Contrato de operación

```ts
// packages/codemode/src/registry.ts
import { defineOp } from "@wefaber/codemode";

export const ops = [
  defineOp({
    id: "checklist.items.create",
    scope: "checklist:write",
    summary: "Crea un item en una lista. Devuelve id y título.",
    input: t.Object({
      listId: t.String(),
      title: t.String({ minLength: 1 }),
    }),
    output: t.Object({ id: t.String(), title: t.String() }),
    async handler(ctx, input) {
      // ctx: { token, tenancy, via: "codemode", requestId }
      const item = await services.items.create(ctx.tenancy, input);
      return { id: item.id, title: item.title }; // R7
    },
  }),
];
```

Reglas del handler:

- Recibe `ctx` con identidad y tenencia ya resueltas. No lee headers.
- Devuelve JSON serializable. Nada de clases, fechas, `undefined` (se normaliza a `null`).
- Errores de dominio se lanzan con `new OpError("NOT_FOUND", "...")`; se traducen a código, no a 500.
- Es idempotente cuando el nombre lo implica (`get`, `list`, `search`).

---

## 5. Contrato del sandbox

Interfaz única, dos adaptadores:

```ts
export interface Sandbox {
  run(input: {
    code: string;                 // body de una función async
    host: HostApi;                // namespaces de funciones, ya con scope aplicado
    limits?: Partial<Limits>;
  }): Promise<RunResult>;         // { ok, result | error: {code, message}, logs, calls, ms, truncated }
}
```

**Adaptador `quickjs`** (default, Bun/Node, VPS): `quickjs-emscripten`. Sin red, sin filesystem, sin `Bun`/`require`/`process`. Corre dentro de un `Bun Worker` que el host puede `terminate()` — obligatorio porque QuickJS no mide bien los builtins de strings grandes (`"x".repeat(1e6)` corrió 12 s con deadline de 2 s, medido en el spike de `mychecklist`).

**Adaptador `quickjs-wasm`** (Cloudflare Worker, sin `worker_loaders`): `@cf-wasm/quickjs`. Mismo contrato y mismas limitaciones que `quickjs`, pero el deadline duro es el límite de CPU del Worker (30 s en Workers Paid, 10 ms en Free — en Free no sirve). Se usa cuando las operaciones necesitan bindings de Cloudflare (D1, R2), como wegraf.

**Adaptador `dynamic-workers`** (Cloudflare, opcional): `DynamicWorkerExecutor` de `@cloudflare/codemode` con binding `worker_loaders` + flag `nodejs_compat`. Aislamiento V8 por ejecución con límites propios. Requiere Workers Paid (mínimo $5/mes) y tiene tope de 4 workers en vuelo por request. Se adopta solo con evidencia de necesidad.

**Regla de elección**: el adaptador lo determina dónde vive el producto y qué necesita su handler, no la preferencia. Producto en VPS → `quickjs`. Producto en Workers con bindings de CF → `quickjs-wasm`. Producto en Workers que necesita aislamiento fuerte o concurrencia alta → `dynamic-workers`. El contrato de operaciones y el spec son idénticos, así que un producto puede mudarse de runtime sin tocar sus ops.

**Tests de escape obligatorios** (bloquean el merge): `fetch`, `WebSocket`, `XMLHttpRequest`, `process`, `require`, `Bun`, `import()`, `eval` de red, `setTimeout` fuera del sandbox; bucle infinito; explosión de memoria; más llamadas que `maxCalls`.

---

## 6. Contrato de transporte

Todo producto expone las mismas tres superficies:

| Superficie | Ruta | Para quién |
|---|---|---|
| HTTP plano | `POST /codemode/search`, `POST /codemode/execute` | agentes sin cliente MCP, scripts, CI |
| MCP | `POST /mcp` (Streamable HTTP) con `search` + `execute` | Claude, Hermes, Codex, OpenCode |
| CLI | `bunx @wefaber/codemode-cli <producto>` (stdio) | agentes locales, sin red al gateway |

Request:

```json
{ "code": "async () => { const xs = await codemode.checklist.lists.list({}); return xs.map(x => x.id) }" }
```

Response:

```json
{ "ok": true, "result": "[\"a\",\"b\"]", "calls": 1, "ms": 41, "truncated": false, "logs": [] }
```

El `code` es siempre el cuerpo de una función async; el resultado es JSON serializado. `search` no tiene host autenticado: solo `spec` (el documento completo, dentro del sandbox) y utilidades puras.

---

## 7. Auth y scopes

- Token por agente: `wcm_<producto>_<32 hex>`, guardado como `sha256` en la tabla `api_tokens` del producto. Se muestra una sola vez.
- El token lleva: producto(s), scopes, rate limit, etiqueta de agente, expiración opcional.
- El gateway reenvía identidad firmada (HMAC con `WCM_GATEWAY_SECRET`) al producto: `x-wcm-token-hash`, `x-wcm-scopes`, `x-wcm-via: gateway`. El producto no confía en el body.
- Efectos secundarios irreversibles (`delete`) DEBERÍAN pedir un paso de confirmación (patrón `propose`/`confirm` que wegraf ya usa) o un scope `admin`.

---

## 8. Gateway: `mcp.wefaber.net`

Un servicio propio en el VPS (Bun, systemd, detrás de Nginx, deploy blue/green), sin lógica de dominio, con una sola responsabilidad: **enrutar**. Cloudflare solo proxya el subdominio al VPS. No hay Worker en el camino: un solo runtime de sandbox (`quickjs`) y un solo pipeline de deploy.

```
                       ┌─────────────────────────────┐
 agente ── /mcp ──────▶│  gateway  mcp.wefaber.net   │
                       │  search  → specs de todos   │
                       │  execute → rutea por prefijo│
                       └──────┬──────────┬───────────┘
                              │          │
                   wegraph.wefaber.net  checklist.wefaber.net
                        /codemode/*        /codemode/*
```

- `search(code)`: corre el código contra el **catálogo** (todos los `spec.json` versionados + sus scopes visibles para ese token). Devuelve solo las operaciones pedidas. El catálogo completo nunca entra al contexto.
- `execute(code)`: intercepta `codemode.<producto>.*` y hace fetch al endpoint `/codemode/execute` del producto, con identidad firmada y presupuesto de llamadas propio.
- Un producto caído devuelve `PRODUCT_UNAVAILABLE` sin tumbar el gateway.
- Presupuesto global por token (llamadas/minuto y bytes/día) en el gateway, no repartido.

**Migración de dirección**: `mcp.wefaber.net` hoy es el worker de wegraf. Pasa a ser el gateway; wegraf se muda a `wegraph.wefaber.net` (su UI sigue en `graph.wefaber.net`, su `/mcp` de producto queda en `wegraph.wefaber.net/mcp`). Es un cambio de `routes` en el wrangler + un DNS, no una reescritura.

---

## 9. Observabilidad

Por corrida, en la D1 del producto o en la del gateway si vino por ahí:

```
run_id, product, token_hash, agent_label, ops[], calls, ms, result_bytes,
truncated, error_code, spec_version, via (gateway|direct|cli), created_at
```

De ahí salen: cuota por agente, operaciones que nadie usa (candidatas a borrar), p95 de latencia por op y tasa de error por producto.

---

## 10. Versionado y compatibilidad

- `spec.version` semver por producto. Agregar una operación es minor. Cambiar o borrar la firma de una existente es major.
- El gateway mantiene un mapa `producto → major conocida`. Si un producto publica una major nueva y el gateway no la conoce, `execute` falla con `SPEC_MISMATCH` en vez de romper en runtime.
- Un producto puede mantener dos majors en paralelo durante una migración (`/codemode/execute?v=2`).
- Deprecación: una operación marcada `deprecated` sigue funcionando, aparece en `search` con la marca, y se borra después de la major siguiente.

---

## 11. Anti-patrones (rechazo en review)

1. Publicar una tool MCP por operación "porque es más simple".
2. Escribir el `spec.json` a mano o editar `client.d.ts` generado.
3. Hacer `fetch` dentro de una operación en vez de llamar al servicio del producto.
4. Devolver la fila completa de la base "por si el agente necesita algo más".
5. Un token global compartido por todos los agentes.
6. Un sandbox sin worker terminable, confiando en el interrupt handler.
7. Un `execute` sin fila de auditoría.
8. Duplicar la lógica de negocio en el handler de la op.

---

## 12. Definition of Done por producto

Un producto está migrado cuando, en un PR revisado:

- [ ] `services/registry.ts` declara todas sus operaciones con `defineOp`.
- [ ] `bun run gen` produce `spec.json` + `client.d.ts`; `bun run check` falla si están viejos.
- [ ] `/mcp` publica exactamente `search` y `execute`.
- [ ] `/codemode/search` y `/codemode/execute` responden con el contrato de §6.
- [ ] Tests de escape y de límites pasan (§5).
- [ ] Test de scope: token `:read` recibe `FORBIDDEN` en una op `:write`.
- [ ] Cada corrida deja fila de auditoría (§9).
- [ ] `spec.json` publicado en el catálogo del gateway.
- [ ] Una corrida real de ejemplo documentada en el README (comando + salida esperada).

---

## 13. Decisiones (cerradas 2026-10-26)

Detalle y evidencia en `./DECISIONS.md`.

**D1 — `mcp.wefaber.net` es el gateway; wegraf se muda a `wegraph.wefaber.net`.** Aceptada. La dirección estable debe ser el gateway; wegraf conserva `/mcp` de producto en su propio host.

**D2 — Tres adaptadores de sandbox, `quickjs` como default.** Aceptada. Verificado: Dynamic Workers es solo Workers Paid ($5/mes, +$0,002 por worker único/día, máx. 4 en vuelo por request). El VPS con QuickJS cubre el volumen actual (decenas de executes/día) a costo cero. wegraf usa `quickjs-wasm` dentro de su Worker porque sus ops necesitan D1/R2. `dynamic-workers` queda como opción a habilitar con datos del tablero de uso.

**D3 — `kit` deja de ser servidor stdio y pasa a catálogo del gateway.** Aceptada. El stdio se genera del mismo registry (`@wefaber/codemode-cli`); `check_conformance` se elimina como tool porque la conformidad es un test, no una operación.
