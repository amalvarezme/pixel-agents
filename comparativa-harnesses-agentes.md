# Harnesses, multiplexores y visualizadores de agentes

> Investigación verificada el 2026-09-06 contra la API de GitHub y los README/blog originales,
> no contra artículos de terceros. Criterio de evaluación: compatibilidad con el stack local
> (Claude Code + gentle-ai + Engram MCP + codegraph) sin romper el contrato de orquestador.

---

## 1. munder-difflin vs. herdr

| | **munder-difflin** | **herdr** |
|---|---|---|
| Repo | `chaitanyagiri/munder-difflin` | `herdrdev/herdr` |
| Qué es | Harness multi-agente con "oficina 2D" y un agente GOD ("Michael") que orquesta | Multiplexor de terminal agent-native: servidor en background que **posee** los terminales |
| Stack | TypeScript · Electron · React · Pixi.js · xterm.js · node-pty | Rust, un solo binario, sin Electron |
| Licencia | MIT | Apache-2.0 |
| Creado | 2026-05-31 | 2026-03-27 |
| Estrellas | 6.506 (833 forks) | 35.833 |
| Estado | v0.4.6 **pre-release** | Estable, Homebrew (`brew install herdr`) |

> Cuidado al buscar herdr: existen decenas de forks y clones con nombre casi idéntico
> (`motionharvest/herdr`, `ogulcancelik/herdr`, `Mihailorama/herdr-terminal`, …).
> El canónico es `herdrdev/herdr` → https://herdr.dev

### Agentes soportados

- **munder-difflin**: claude, agy (Antigravity), codex, grok, kimi, qwen, opencode, crush, pi, copilot, cursor, + comando custom. BYOK y modelos locales (Ollama, LM Studio, vLLM).
- **herdr**: claude code, codex, cursor, opencode, grok, pi, copilot cli, hermes, omp, qodercli. Como multiplexor genérico funciona con cualquier cosa que corra en un terminal.

### Arquitectura de munder-difflin

```
            tú ── hablas con ──►  ┌─────────────┐
                                  │  GOD agent  │  roster · routing · adjudicación
                                  │  (Michael)  │  blackboard · task ledger
                                  └──────┬──────┘
                                         │ asigna · rutea · escala
              ┌──────────────────────────┼──────────────────────────┐
              ▼                          ▼                          ▼
        ┌───────────┐             ┌───────────┐             ┌───────────┐
        │  agent A  │  mensaje    │  agent B  │  mensaje    │  agent C  │
        │ + memoria │ ──────────► │ + memoria │ ──────────► │ + memoria │
        └───────────┘             └───────────┘             └───────────┘
              └────── hive: memoria · mailbox · blackboard · log ──────┘
```

El hive es un repo git local con `outbox/` e `inbox/`; ningún agente toca git directamente
(diseño single-committer para evitar corrupción de `index.lock`).

### Compatibilidad con Claude Code

**Los dos son compatibles** — ninguno reimplementa el modelo, ambos lanzan el binario `claude`
real en un PTY. Pero el mecanismo difiere y eso lo cambia todo:

- **munder-difflin** inyecta en cada sesión:
  - rol/protocolo vía `--append-system-prompt`
  - hooks de ciclo de vida vía `--settings` (archivo **fuera** del repo, aditivo)
  - env vars `AGENT_ID`, `AGENT_NAME`

  Por eso hereda MCP servers user-scoped y project-scoped, y las skills, sin reconfigurar.
  Fuente: `blog/src/posts/mcp-and-skills-in-a-hive.md` del propio repo.

- **herdr** no inyecta **nada**. "No envuelve ni reemplaza los agentes; posee sus terminales."

### Compatibilidad con Engram

Compatible en ambos: es un MCP server user-scoped y se hereda.

Detalle no trivial: munder-difflin corre su **propia** capa de memoria semántica que
deliberadamente NO ocupa un slot MCP (va por CLI + env var a un store compartido).
Resultado: dos memorias en paralelo, Engram y la del hive, sin nada que las reconcilie.

### Compatibilidad con gentle-ai — el problema real

El `CLAUDE.md` global define un contrato de **orquestador único**: RDD/receipt-driven,
lineage, recibos, un solo writer, delegación controlada.

munder-difflin arranca N sesiones `claude` en paralelo y **cada una carga ese mismo CLAUDE.md**.
Cada agente se cree el orquestador, con su `--append-system-prompt` compitiendo encima.
Sumado a N escritores concurrentes contra Engram (que ya genera *conflict candidates* con un
solo escritor), hay colisión de contratos — no de herramientas.

> ⚠️ Esto es **inferencia de diseño, no probado en ejecución**. Pero es la consecuencia directa
> de que uno inyecte system prompt y el otro no.

### Veredicto: herdr

No por las estrellas, sino por la razón arquitectónica: la inversión ya está en la capa de
configuración de Claude Code (CLAUDE.md, gentle-ai, Engram, codegraph, ~20 skills, SDD).
Hace falta un multiplexor **transparente**, no un harness que ponga otro orquestador encima
del que ya existe.

herdr aporta paralelismo, persistencia entre reboots, reattach por SSH y estado
working/blocked/idle sin tocar el contrato. Binario Rust, no app Electron pre-release.

munder-difflin es más impresionante de ver, pero resuelve un problema **ya resuelto**
(coordinación, memoria, roles). Es sustitutivo de gentle-ai, no complementario.

**Si aun así se quiere probar:** repo desechable, `CLAUDE.md` mínimo y
`gentle-ai review mode disable --scope clone`, para ver el harness sin dos orquestadores
peleándose.

---

## 2. Visualizadores tipo oficina

### La distinción que importa

Hay dos arquitecturas y sólo una cumple el requisito de "no inyectar nada":

| | **(A) Basados en hooks** | **(B) Lectores pasivos de logs** |
|---|---|---|
| Cómo obtienen datos | Añaden entradas a `~/.claude/settings.json` (`PreToolUse`/`PostToolUse`) que hacen `curl` a un server local | Leen `~/.claude/projects`, `~/.codex/sessions` en disco |
| ¿Inyecta system prompt? | No | No |
| ¿Toca la config? | **Sí** — el mismo archivo donde vive el hook `SessionStart` de Engram | **Nada** |
| Multi-agente | Imposible: hooks es feature exclusiva de Claude Code | Sí, cualquier CLI que escriba logs |

Los hooks de Claude Code se **fusionan**, así que en runtime no chocarían con Engram.
El riesgo real es el *instalador* reescribiendo `~/.claude/settings.json`.

Aun así, la categoría (A) queda descartada por el otro requisito: **no puede soportar Codex,
Antigravity ni OpenCode**, porque esos CLIs no tienen hooks.

### Recomendado: `percheniy/office-for-claude-agents`

24★ · TypeScript · README en RU/EN/ZH · push 2026-08-05

Verificado en su `README_EN.md` (líneas 216–245), no en el marketing:

- **Auto-detecta** `~/.claude/projects`, `~/.codex/sessions` y `~/.codex/archived_sessions`.
  Override con `PIXEL_AGENTS_CLAUDE_PROJECTS_DIR`, `PIXEL_AGENTS_CODEX_SESSIONS_DIR` o
  `~/.pixel-agents/config.json` — misma familia de env vars que pixel-agents, pero **sin hooks**.
- **Adaptadores JSONL genéricos** para OpenCode, Gemini, Kimi, Qwen, DeepSeek y Copilot
  (`events.jsonl`), con eventos normalizados: `session_start`, `tool_start`, `tool_end`,
  `message`, `stats`, `status`, `parent`, `session_end`. Los providers desconocidos se
  preservan como badges — ahí entraría Antigravity.
- Detalle que revela el criterio del autor: **deliberadamente NO lee la SQLite nativa de
  OpenCode**, para evitar riesgo de escritura sobre esa base.
- Sin API, sin coste extra de tokens. Sirve en `localhost:9876`.
- Muestra jerarquía padre-hijo, clusters, quién espera aprobación y consumo de tokens.

**Compone con herdr sin saber que existe.** herdr posee el terminal, pero `claude` y `codex`
siguen escribiendo sus logs de sesión donde siempre. El visualizador los lee desde disco.
Cero acoplamiento entre ambos, cero conflicto con gentle-ai porque nada entra al prompt.

**Lo débil, dicho claro:** 24 estrellas, último push 2026-08-05, y el propio README admite que
el soporte de Codex "es básico y todavía necesita refinamiento". Antigravity no está soportado
nativamente (0 hits en el repo) — habría que emitir el JSONL normalizado a mano.

### Segundo, si sólo importa OpenCode

`psinetron/opencode-visualiser` — 159★ · MIT · npm `psinetron-opencode-visualizer`

Se instala como plugin de OpenCode (`opencode plugin psinetron-opencode-visualizer`), corre
sobre el Bun que OpenCode ya trae, abre ventana Chrome nativa sin Electron. Toca
`opencode.json`, nunca `~/.claude`. Sólo OpenCode, pero muy limpio en su nicho.

### Descartados — categoría (A), piden editar `~/.claude/settings.json`

| Repo | ★ | Nota |
|---|---|---|
| `hoangsonww/Claude-Code-Agent-Monitor` | 980 | El más pulido. 327 referencias a hooks. Claude+Codex, kanban, app nativa |
| `FulAppiOS/Agent-Quest` | 134 | Fantasía medieval gamificada. Claude+Codex |
| `W17ant/Claude-Office` | 133 | Isométrico pixel; README confirma `PreToolUse`/`PostToolUse` + editar `~/.claude/settings.json`. Tiene modo Dunder Mifflin literal |
| `coding-by-feng/ai-agent-session-center` | 82 | Robots 3D, Three.js, terminales en vivo |

### Resto del nicho — inmaduro

| Repo | ★ | Nota |
|---|---|---|
| `ruiqili2/agent-monitor` | 55 | Sólo OpenClaw |
| `rolandal/pixel-agents-standalone` | 52 | Fork de `pablodelucca/pixel-agents` |
| `thx0701/openclaw-virtual-office` | 48 | Sólo OpenClaw |
| `rdwnilyas-coder/pixel-hero-agents` | 16 | Héroes animales, top-down |
| `shahar061/the-office` | 14 | Electron |
| `leavemagic-cyber/ai-office-dollhouse` | 1 | Overlay 2.5D Windows: Codex+Claude+Gemini+Grok |

### Observación de fondo

La estética de oficina pixel es un mercado de juguetes con 20–150 estrellas. Lo que herdr da
—working/blocked/idle por pane— resuelve el 90% del problema real: saber cuál agente está
atascado. El visualizador es la capa de placer, no la de información.

---

## Fuentes

- https://github.com/chaitanyagiri/munder-difflin
- https://github.com/chaitanyagiri/munder-difflin/blob/main/blog/src/posts/mcp-and-skills-in-a-hive.md
- https://github.com/herdrdev/herdr · https://herdr.dev/docs/
- https://github.com/percheniy/office-for-claude-agents
- https://github.com/psinetron/opencode-visualiser
- https://github.com/W17ant/Claude-Office
- https://github.com/hoangsonww/Claude-Code-Agent-Monitor
- https://github.com/FulAppiOS/Agent-Quest
- https://github.com/ruiqili2/agent-monitor
