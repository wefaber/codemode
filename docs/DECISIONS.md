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

---

## D4 — Clef en el gateway: ranker opcional sobre `search`, no router de tools

**Estado: propuesta** (2026-11-01). Sin evaluación propia todavía; los puntos marcados "por confirmar" vienen del informe de Ether y no se verificaron contra el código de WeGraph.

### Qué se propone en el diagrama

`AI Agent → request → Code Mode Gateway → Clef → Tool → {Design, Programming, Graph, Rules}`. El agente expone qué puede proporcionar; Clef decide qué tools hacen falta para ese tipo de request y, si lo considera útil, aprueba y devuelve las Tools necesarias.

### Qué hay hoy

- En este repo no hay nada sobre Clef: `docs/` y el árbol no lo mencionan, y no existe `apps/gateway`.
- Lo medido está en WeGraph (por confirmar: `wegraph/docs/EVALUATION.md:114-141`): gate de relevancia por nodo con `@cf/cloudflare/clef-flash` (9B), coherencia de diseño 56% → 89%, tokens de entrada 929 → 425, evitación de errores 33% → 100%. Cambiar el wording sí/no bajó el AUC de 0,71 a 0,54.
- Ahí Clef es un **gate de relevancia** (devuelve probabilidades, nunca texto) y no un router de tools. El candidato que no pasa no viaja en el contexto; no es un error.
- La escalada a `clef` (27B) está declarada pero no se ejecuta (`escalated_score` siempre es null). Modelos chicos de la familia (144M, 421M, 4B) se descartaron por degenerar el gate.
- LiquidAI: se evaluó según Faku, pero no hay registro citable. Sin números no entra en la decisión.
- Inferencia: no corre en el VPS (6 cores, sin GPU). En WeGraph corre por Workers AI dentro del Worker, o local por llama.cpp.

### Choque con el spec

- **R2** fija exactamente dos tools (`search`, `execute`). Un modelo que arma la lista de tools devueltas es publicar tools por la puerta de atrás.
- **§8** define el gateway como "sin lógica de dominio, una sola responsabilidad: enrutar", y el gateway es stateless. Un modelo en el camino crítico agrega una dependencia de IA, latencia y un modo de falla nuevo.
- El gate con rechazo ("aprueba si es útil") deja al agente trabado cuando Clef se equivoca; un falso negativo cuesta más que devolver una tool de más.

### Propuesta

1. **Clef no decide qué tools existen.** El agente sigue viendo `search` + `execute` (R2 intacto). Clef, si se usa, **ordena y recorta** lo que devuelve `search` sobre el catálogo.
2. **Es degradable.** Si Clef falla, `search` devuelve el orden determinístico del catálogo (prefijo `codemode.<producto>.*` y palabras clave). El gateway sigue stateless y funcional sin modelo.
3. **Salida cerrada.** La entrada es el request más los IDs de ops candidatas; la salida es una lista de IDs con score. Nunca texto libre. Una inyección en el request solo puede reordenar.
4. **Permisos antes del modelo.** Los scopes del token filtran los candidatos antes de que lleguen a Clef. El modelo nunca amplía permisos ni los decide.
5. **No hay rechazo duro.** Baja confianza → se devuelve el conjunto completo del producto, ordenado. Se prefiere recall sobre precision.
6. **Escalada por confianza** (27B) solo si Flash no alcanza en la evaluación, no por defecto.
7. **Log de decisiones**: request, candidatos, orden devuelto y si el agente terminó pidiendo más. Es el dataset para mejorar el ranking y se suma a la tabla de auditoría de §9.

### Criterio de aceptación

Clef entra al gateway solo si **supera al baseline determinístico en recall@k** sobre un set etiquetado propio (requests reales por tipo: Design, Programming, Graph, Rules). El umbral de k y de mejora se fija **antes** de correr la evaluación. Se comparan `clef-flash`, `clef` 27B y LiquidAI sobre el mismo set, con latencia p95 medida en el lugar donde correría.

### Preguntas abiertas

- **Dónde corre la inferencia para el gateway.** El gateway vive en el VPS (D2) y no hay GPU: implica llamar a Workers AI por API. El token de Cloudflare disponible en el VPS es solo de zona (D2); hace falta uno con permiso de Workers AI. Presupuesto de latencia por definir.
- **`Rules` no es una tool**: es contexto o política. Decidir si se sirve como op de catálogo o se inyecta aparte.
- **Estado por sesión**: grants con TTL para no renegociar en cada llamada, o stateless puro.
- **LiquidAI**: registrar la evaluación previa (o repetirla) antes de usarla como argumento.

### Qué se descarta

Clef como router que arma el listado de tools y como gate que aprueba o rechaza requests del agente.

### Fuente

Informe de Ether (sesión `codemode-clef`, 2026-11-01), contrastado contra `docs/` y `SPEC.md` de este repo.

---

## D5 — Gateway: reenvío por código, tokens propios e identidad firmada

**Estado: propuesta** (2026-11-01), implementada en `apps/gateway` (PLAN Fase 5, tareas 5.1 a 5.3). Se acepta con el merge del PR.

Lo que el plan no fijaba y hubo que decidir:

1. **`Bun.serve()` en vez de Elysia.** El gateway es un único `fetch(Request) → Response` sobre el handler web del paquete; no hay rutas con esquema ni GraphQL. Es el caso de "shell chico" de la regla de la casa.
2. **Cada llamada se reenvía como un `execute` del producto.** `await codemode.todo.items.create(x)` hace `POST <url>/codemode/execute` con `return await codemode.todo.items.create(x)`. Los productos no cambian y siguen validando entrada y scope por su cuenta (SPEC §6, R3). Costo: una corrida de producto por llamada. Alternativa descartada: un endpoint por operación, que agrega una cuarta superficie al contrato. Se revisa con el p95 de la tabla `runs`.
3. **Tokens propios del gateway** (`sha256`, scopes que cubren varios productos, importación de los `mck_…` existentes). Validar contra cada producto no sirve: el gateway necesita los scopes antes de armar `search` y el namespace de `execute` (R5).
4. **Identidad firmada** (`signIdentity` / `verifyIdentity` viven en `@wefaber/codemode-mcp`, no en el gateway, para que los productos la importen en vez de copiarla): `x-wcm-via`, `x-wcm-token-hash`, `x-wcm-scopes`, `x-wcm-agent`, `x-wcm-run-id`, `x-wcm-timestamp` y `x-wcm-signature` (HMAC-SHA256 sobre esos campos con `WCM_GATEWAY_SECRET`), con tolerancia de 60 s. El token del agente nunca llega al producto; el `run_id` es el mismo para todas las llamadas de una corrida, así que cada producto liga su auditoría a la del gateway.
5. **Presupuesto**: por token, corridas por minuto (en memoria), llamadas a productos por minuto y bytes de resultado por día (ambos en SQLite, tablas `call_usage` y `usage`). Cada llamada reenviada cuenta una; pasado el límite falla con `RATE_LIMITED` sin tocar al producto. Ventana fija de un minuto calendario (simple y atómica en una sentencia; permite una ráfaga de hasta 2× el límite en el borde entre dos minutos). Default `WCM_CALLS_PER_MINUTE=600`: una corrida admite 50 llamadas (R6) y 60 corridas por minuto podrían hacer 3000, así que 600 es un techo real sin molestar a un uso normal (~60 corridas de 10 llamadas). Se ajusta con la tabla `runs`.

La decisión se revisa con datos de la tabla `runs` (SPEC §9), igual que D2.
