# Instrucciones para un agente de código — Pixel Office v2

## 1. Misión

Implementar o integrar un escenario 2D de oficina tecnológica usando **los assets y contratos existentes de este repositorio**. No se debe reconstruir la lógica a partir de coordenadas visuales ni incrustar muebles dentro de los personajes.

El resultado esperado es una oficina en la cual Alex, Marcus, Sophia y Elena puedan navegar, utilizar portátiles, consultar la memoria persistente, conversar y reaccionar al Sentinel exterior.

---

## 2. Fuente de verdad

Leer primero estos archivos:

```text
README.md
02_environment/office/office_map.json
01_characters/<id>/<id>.json
04_engine/*.js
```

`office_map.json` es la fuente de verdad del mundo. Los JSON de personajes son la fuente de verdad de las animaciones.

No codificar manualmente FPS, filas del spritesheet, anchors ni coordenadas de estaciones si ya existen en JSON.

---

## 3. Arquitectura de assets

```text
pixel_office_v2/
├── 01_characters/
│   ├── alex/
│   ├── marcus/
│   ├── sophia/
│   ├── elena/
│   └── sentinel/
├── 02_environment/office/
│   ├── background.png
│   ├── foreground.png
│   ├── window_mask.png
│   ├── office_source_reference.png
│   ├── office_map.json
│   └── scene_debug.png
├── 03_ui/
├── 04_engine/
├── 05_examples/
├── 06_docs/
└── 07_tools/
```

Los assets `legacy/` dentro de cada personaje existen solo para referencia y compatibilidad con v1. Para código nuevo usar los archivos v2.

---

## 4. Orden de renderizado obligatorio

Renderizar en este orden:

```text
1. background.png
2. Sentinel exterior, RECORTADO por window_mask.png
3. agentes interiores ordenados por footY
4. foreground.png
5. UI
```

Esto garantiza que:

- el Sentinel permanezca fuera de la oficina;
- los marcos de ventana y máscara limiten su visibilidad;
- los personajes puedan quedar detrás de escritorios, plantas y sofá;
- la escena conserve profundidad 2D.

`OfficeWorld.js` ya implementa este orden.

---

## 5. Personajes v2

Cada personaje interior utiliza frames de 32×32 px y un origen en los pies:

```json
"origin": { "x": 16, "y": 30 }
```

La posición `(agent.x, agent.y)` representa los **pies**, no la esquina superior izquierda.

### Animaciones y direcciones

Los JSON exponen grupos como:

```text
idle:   down / up / side
walk:   down / up / side
work:   up
 typing: up
 talk:   down / up / side
 point:  down / up / side
 celebrate: down
 sit:    down
```

`side` está dibujado mirando a la derecha. Para mirar a la izquierda se debe aplicar mirror horizontal en runtime.

No crear una segunda copia gráfica para `left`.

### Regla crítica

Los sprites v2 son **body-only**. No se deben añadir escritorios, sillas o portátiles a `work`, `typing` o `sit`.

Los objetos pertenecen al escenario.

---

## 6. Escala y pixel-perfect

Desactivar interpolación:

```javascript
ctx.imageSmoothingEnabled = false;
```

Y en CSS:

```css
canvas { image-rendering: pixelated; }
```

Utilizar `map.depth.scaleBands` para seleccionar escala según `footY`.

No usar escalado bilinear/bicubic.

---

## 7. Navegación

`office_map.json` define:

```text
navigation.gridSize
navigation.walkableBounds
navigation.collisionZones
```

`Navigation.js` genera una malla A* en runtime.

Para mover un agente:

```javascript
const path = world.navigation.findPath(
  { x: agent.x, y: agent.y },
  { x: target.x, y: target.y }
);

agent.followPath(path);
```

No desplazar en línea recta atravesando escritorios.

### Ajuste fino

Las colisiones actuales son rectángulos aproximados derivados del arte. Si durante pruebas se observa clipping de algunos píxeles, ajustar exclusivamente `office_map.json`. No modificar el motor para resolver errores de geometría específicos de un mueble.

---

## 8. Puestos de trabajo

Existen **11 workstations**:

```text
ws_01 ... ws_11
```

Cada estación contiene:

```json
{
  "type": "workstation",
  "interactionAnchor": { "x": 225, "y": 612 },
  "facing": "up",
  "actions": ["work", "typing"],
  "defaultAnimation": "typing"
}
```

Flujo correcto:

```text
agent
  -> pathfinding hasta interactionAnchor
  -> facing = target.facing
  -> typing/work
```

Ejemplo:

```javascript
interactions.use(alex, "ws_03");
```

No usar la coordenada visual del portátil como posición del personaje. Usar `interactionAnchor`.

---

## 9. Persistent Memory Archive

ID:

```text
persistent_memory
```

Acciones semánticas:

```text
read_memory
write_memory
search_memory
sync_memory
```

Estas acciones pueden mapear inicialmente a `point` mientras se implementan animaciones específicas.

Arquitectura sugerida:

```javascript
await agent.goTo("persistent_memory");
agent.setAction("point", "up");
ui.showStatus("ACCESSING MEMORY...");
```

El sistema de negocio puede asociar esta interacción con RAG, memoria persistente real, base vectorial o APIs externas sin modificar el asset gráfico.

---

## 10. Interacciones entre agentes

Para conversación:

1. calcular un anchor cercano al agente objetivo;
2. navegar hasta dicho anchor;
3. orientar ambos agentes uno frente al otro;
4. activar `talk`;
5. mostrar UI de diálogo por separado.

No dibujar texto dentro del spritesheet.

Interfaz sugerida:

```javascript
await interaction.talkTo(sophia, alex);
```

Esta API no está implementada todavía; es una extensión recomendada de `InteractionSystem.js`.

---

## 11. Sentinel exterior

El Sentinel es un asset independiente en:

```text
01_characters/sentinel/
```

Animaciones:

```text
idle
walk
scan
look
alert
disappear
```

Nunca debe incorporarse a la lista de entidades interiores ni participar en el A* de oficina.

Se renderiza a través de `window_mask.png`.

Flujo recomendado:

```text
walk -> scan -> look -> alert -> walk
```

Puede disparar eventos interiores, por ejemplo:

```javascript
world.events.emit("sentinel:alert");
```

Los agentes podrían responder:

```text
idle -> talk
work -> idle
point hacia ventana
mostrar alerta UI
```

Mantener al Sentinel como un diseño original de ciencia ficción; no renombrarlo como un personaje de una franquicia.

---

## 12. Profundidad y oclusión

Ordenar agentes por la coordenada de sus pies:

```javascript
agents.sort((a, b) => a.y - b.y);
```

Después dibujar `foreground.png`.

No ordenar por el centro del sprite ni por su esquina superior izquierda.

---

## 13. Colisiones del personaje

Los JSON definen una hitbox pequeña alrededor de los pies. No usar 32×32 px completos.

Esto permite que cabeza y torso se superpongan visualmente a escritorios y plantas sin bloquear navegación de forma artificial.

---

## 14. Runtime existente

### `CharacterAnimator.js`

Responsabilidad:

- resolver dirección y fallback;
- FPS;
- frame actual;
- loop;
- mirror lateral;
- draw pixel-perfect.

### `OfficeAgent.js`

Responsabilidad:

- posición;
- dirección;
- seguimiento de path;
- estado;
- animación durante movimiento.

### `Navigation.js`

Responsabilidad:

- A*;
- grid;
- colisiones.

### `InteractionSystem.js`

Responsabilidad:

- resolver target;
- llegar a anchor;
- iniciar acción.

### `OfficeWorld.js`

Responsabilidad:

- carga del mapa;
- capas;
- Y-sorting;
- Sentinel con window mask;
- renderizado.

### `SentinelController.js`

Responsabilidad:

- recorrido exterior;
- scan/walk básico.

---

## 15. Demo

Ejecutar desde la raíz:

```bash
python -m http.server 8000
```

Abrir:

```text
http://localhost:8000/05_examples/
```

La demo permite:

- cargar los cuatro personajes;
- ver el Sentinel;
- mover Alex con clic;
- enviar Alex a WS03;
- enviar Alex a memoria persistente;
- enviar Alex a la ventana;
- visualizar colisiones con el botón Debug.

No abrir `index.html` directamente con `file://`; los ES Modules y `fetch()` requieren un servidor HTTP.

---

## 16. Implementación recomendada por fases

### Fase 1 — Validación

Ejecutar:

```bash
python 07_tools/validate_package.py
```

Corregir cualquier error antes de modificar runtime.

### Fase 2 — Escena base

Verificar:

```text
background -> sentinel masked -> agents -> foreground
```

### Fase 3 — Navegación

Probar todos los anchors `ws_01 ... ws_11`.

### Fase 4 — Interacción

Implementar:

```text
use workstation
persistent memory
window observation
meeting sofa
```

### Fase 5 — Agent-to-agent

Agregar:

```text
talkTo()
follow()
meetAt()
```

### Fase 6 — Eventos

Agregar event bus:

```text
sentinel:visible
sentinel:scan
sentinel:alert
memory:read
memory:write
task:completed
```

### Fase 7 — Backend real

Conectar las acciones semánticas del mundo con agentes de IA reales, sin mezclar esa lógica con el renderer.

Ejemplo:

```text
OfficeWorld = representación visual
Agent Runtime = razonamiento/tareas
Memory Service = memoria persistente
Event Bus = comunicación
```

---

## 17. Separación recomendada de responsabilidades

No colocar llamadas LLM dentro de `OfficeWorld.js`.

Arquitectura objetivo:

```text
AI Agent Runtime
       |
       v
Task / Event Controller
       |
       v
OfficeAgent
       |
       v
OfficeWorld / Renderer
```

Memoria:

```text
AI Agent Runtime <-> Persistent Memory Service
                         |
                         v
              visual event in office
```

---

## 18. Criterios de aceptación

La integración se considera correcta cuando:

```text
[ ] background.png carga
[ ] foreground.png carga
[ ] window_mask.png carga
[ ] cuatro agentes cargan desde JSON
[ ] Sentinel carga desde JSON
[ ] izquierda usa mirror del sprite side
[ ] walk funciona en cuatro direcciones lógicas
[ ] personajes no llevan muebles incrustados
[ ] A* evita escritorios principales
[ ] se puede llegar a ws_01...ws_11
[ ] typing se ejecuta mirando hacia el portátil
[ ] memoria persistente es interactiva
[ ] Sentinel solo se ve a través de la ventana
[ ] Y-sorting funciona
[ ] foreground oculta correctamente partes del personaje
[ ] el render sigue siendo pixel-perfect
[ ] lógica de IA está desacoplada del renderer
```

---

## 19. Limitaciones conocidas de esta versión

1. `background.png` es una limpieza programática del escenario original para retirar el robot estático. Puede refinarse artísticamente sin cambiar contratos de código.
2. Las collision zones son aproximaciones rectangulares; el agente de código puede afinarlas editando `office_map.json`.
3. `work` y `typing` son animaciones corporales simples; no se modelan manos sobre una tecla exacta del portátil.
4. `talkTo()` y un event bus completo son extensiones recomendadas, no implementadas aún.
5. Las coordenadas están acopladas al escenario 1672×941; si se reemplaza el fondo por otro tamaño, debe actualizarse `office_map.json`.

---

## 20. Regla de mantenimiento

Si se cambia un asset visual pero se preservan dimensiones, anchors y IDs, no debe ser necesario modificar el runtime.

Si se cambia:

```text
frame size
world size
row mappings
anchors
collision geometry
```

actualizar primero los JSON correspondientes y después validar el paquete.
