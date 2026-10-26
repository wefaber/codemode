# Decisiones WCM

Registro de las decisiones de `SPEC.md §13`, con la evidencia que las sostiene.

---

## D1 — `mcp.wefaber.net` como gateway; wegraf a `wegraph.wefaber.net`

**Estado: aceptada** (2026-10-26).

`mcp.wefaber.net` es la dirección estable que un agente configura una vez. Si cada producto vive en su propio host, el agente acumula N endpoints y N tokens; el gateway es justamente lo que evita eso. wegraf conserva su `/mcp` de producto en `wegraph.wefaber.net/mcp` para desarrollo y para quien quiera ir directo.

Consecuencia operativa: un cambio de `routes` en `deployments/wefaber.wrangler.jsonc` + DNS. Su UI sigue en `graph.wefaber.net`.

---

## D2 — Runtime del sandbox

**Estado: aceptada con tres runtimes** (2026-10-26). Verificado, no supuesto.

### Lo que dicen los datos

Medido hoy:

- `mcp.wefaber.net/mcp` → `tools/list` = **16.670 bytes, 23 tools**. A ~4 caracteres por token son **~4.100 tokens de esquemas** que se pagan en cada sesión que carga ese servidor.
- `get_feedback` de wegraf: **0 reviews desde 2026-10-19**, 0 run logs. La telemetría de agente de wegraf está prácticamente vacía.
- El token de Cloudflare disponible (`~/.cloudflare-api-token`) es **solo de zona**: no puede leer el plan ni las suscripciones de la cuenta. El plan de Workers no se puede verificar por API con lo que hay en el VPS.

Documentación oficial (Dynamic Workers, actualizada 2026-08-27):

- **"Dynamic Workers are currently only available on the Workers Paid plan."** Mínimo $5/mes.
- Cobro: 1.000 dynamic workers únicos/mes incluidos, **+$0,002 por worker único por día**; requests y CPU a tarifa Standard (10 M requests y 30 M CPU-ms incluidos).
- Un worker es único por `ID` + `code`. Con `.load(code)` sin ID estable, **cada invocación cuenta como uno nuevo**.
- Concurrencia: **máximo 4 dynamic workers en vuelo por request** de Worker (10 por Durable Object).

Alternativa verificada que no requiere plan pago: **`@cf-wasm/quickjs`** expone QuickJS compilado a wasm para Workers/Pages (`quickjs-emscripten` también corre en Workers usando la variante wasm como módulo, no como fetch).

### Costo estimado con el volumen actual

| Escenario | `quickjs` VPS | `workers` (Dynamic Workers) |
|---|---|---|
| 10 executes/día | $0 | ~$5/mes (300 workers/mes, bajo el incluido) |
| 100 executes/día | $0 | ~$9/mes (3.000 workers/mes, 2.000 extra) |
| 1.000 executes/día | $0 marginal, CPU del VPS | ~$45/mes solo en creación de workers |

Con ID estable (hash del código generado) el número de workers únicos por día colapsa a "variantes de script distintas", que en la práctica son decenas. El costo real baja, pero el piso de $5/mes no.

### Decisión

**Tres adaptadores, un contrato.**

| Adaptador | Corre en | Requiere | Cuándo |
|---|---|---|---|
| `quickjs` | VPS, Bun Worker terminable | nada | **default** para todo producto alojado en el VPS |
| `quickjs-wasm` | dentro de un Cloudflare Worker (`@cf-wasm/quickjs`) | Workers Paid por CPU (30 s en vez de 10 ms) | producto cuyas ops necesitan bindings de CF (D1, R2) — es el caso de wegraf |
| `dynamic-workers` | isolate V8 por ejecución | Workers Paid + `worker_loaders` | solo si se necesita aislamiento más fuerte que wasm o concurrencia masiva |

**Por qué `quickjs` es el default**: el sandbox ya existe y está probado en Bun (284 líneas, límites medidos), el VPS ya está pagado, el pipeline de deploy ya existe, y el volumen de agentes hoy es de decenas de ejecuciones por día. Agregar $5/mes y una dependencia de plan no compra nada a ese volumen.

**Por qué wegraf no puede usar el adaptador del VPS**: sus ops necesitan `env.DB` (D1) y `env.BUCKET` (R2). El sandbox tiene que vivir donde viven esos bindings. De ahí `quickjs-wasm` dentro del Worker.

**Por qué no `dynamic-workers` todavía**: el aislamiento de wasm con worker terminable ya cubre el riesgo real (código generado que cuelga o explota memoria). Dynamic Workers agrega aislamiento de V8 y límites por worker, a cambio de un piso de $5/mes, un límite de 4 en vuelo por request y una API beta. Se adopta cuando el tablero de uso (Fase 8) muestre necesidad real: >500 executes/día o incidentes de sandbox.

**La decisión se revisa con datos, no con opinión**: la tabla de auditoría de §9 del SPEC da executes/día, p95 y errores por código. Con esos números, migrar de adaptador es cambiar una línea de wiring.

### Escalabilidad — qué se rompe primero, en orden

1. **Concurrencia en el VPS**: cada execute es un Bun Worker con su QuickJS. ~50 concurrentes es cómodo; ~500 no. Se mitiga con un pool y una cola con presupuesto por token.
2. **Punto único de falla**: si el gateway vive en el VPS y el VPS cae, todos los productos caen para los agentes. Mitigación: el gateway es stateless, corre detrás de Nginx con blue/green, y cada producto conserva su endpoint directo (el agente puede apuntar ahí si el gateway no responde).
3. **Blast radius del sandbox**: mitigado por el worker terminable + límites duros. Es el riesgo que más importa y el que está mejor cubierto.
4. **Cloudflare**: no escala el sandbox, escala el borde. Si el día de mañana hay agentes en muchas regiones con latencia crítica, se mueve el gateway a CF y se paga el plan.

---

## D3 — `kit` deja de ser servidor stdio y pasa a catálogo del gateway

**Estado: aceptada** (2026-10-26). El razonamiento, porque pediste entenderlo.

### Qué es hoy

`kit/mcp/src/index.ts`: 4 tools (`get_standard`, `get_theme`, `list_packages`, `check_conformance`), transporte **stdio**, sin auth. Se usa clonando el repo y corriendo `bun`.

### Por qué se migra

1. **Es contenido, no un servicio.** Las 4 tools leen archivos estáticos del repo. No hay estado, no hay tenancy, no hay efectos. Un catálogo de contenido estático es exactamente lo que `search` resuelve mejor: el agente pide "el estándar de diseño de la org wefaber" y recibe eso; hoy paga los 4 esquemas en cada sesión para después leer uno.
2. **stdio no viaja.** Funciona en la máquina donde clonaste el repo. Hermes en el VPS lo ve; Claude Code en tu PC lo ve si lo instalaste; un agente remoto, o vos en otra máquina, no. A través del gateway queda disponible con un token, sin instalar nada.
3. **Duplica la definición de conformidad.** `check_conformance` vive en kit, pero WCM ya define una suite de conformidad compartida (Fase 3). Dos definiciones de "conformance" es exactamente el problema que el estándar viene a resolver. En WCM, la conformidad es un test del repo, no una tool.
4. **R1 — un registry por producto.** Los estándares pasan a ser ops versionadas: `kit.standards.get`, `kit.themes.get`, `kit.packages.list`. Cambiar un estándar pasa a ser un cambio de spec con semver, no un reemplazo silencioso de un archivo que nadie rastrea.
5. **Un token, no cuatro configuraciones.** Hoy, un agente que quiere estándares + grafo + checklists configura tres servidores con tres mecanismos. Después del gateway configura uno.

### Qué se pierde y cómo se compensa

Se pierde el camino de cero configuración para Claude Code, que es un beneficio real. Se compensa así: el CLI stdio **se genera del mismo registry** (`@wefaber/codemode-cli`, Fase 1.6). Claude Code sigue teniendo un servidor local — generado, no escrito a mano — y el registro es el mismo que usa el gateway. Un solo lugar donde agregar una operación.

Si el CLI generado resulta peor que el actual en la práctica, se vuelve atrás sin tocar el registry: es una decisión de transporte, no de modelo de datos.
