# Guía para agentes de IA — Integración de personajes Pixel Office

## 1. Objetivo

Este documento explica cómo utilizar el paquete de personajes **Pixel Office** generado para una aplicación 2D tipo oficina tecnológica.

El agente debe tratar estos archivos como **assets gráficos listos para integración**, no como imágenes decorativas. Cada personaje incluye:

- sprite sheet PNG con fondo transparente;
- frames PNG individuales;
- archivo JSON con metadatos de animación;
- retrato PNG;
- GIF de previsualización.

El objetivo principal es permitir que una aplicación pueda:

- mostrar personajes;
- reproducir animaciones;
- cambiar de estado;
- mover personajes por una escena;
- ejecutar acciones de oficina;
- mantener escalado pixel-perfect.

## 2. Estructura general del paquete

```text
pixel_office_characters/
├── alex/
│   ├── alex_spritesheet.png
│   ├── alex.json
│   ├── alex_preview.gif
│   ├── alex_portrait.png
│   └── frames/
│       ├── idle/
│       ├── walk/
│       ├── work/
│       ├── typing/
│       ├── talk/
│       ├── point/
│       ├── celebrate/
│       └── sit/
├── marcus/
├── sophia/
├── elena/
├── characters_manifest.json
├── pixel_office_player.js
├── demo.html
└── README.md
```

## 3. Personajes disponibles

| ID | Nombre | Rol |
|---|---|---|
| `alex` | Alex | Software Developer |
| `marcus` | Marcus | IT / DevOps Engineer |
| `sophia` | Sophia | UX/UI Designer |
| `elena` | Elena | Data Scientist / AI Engineer |

Los IDs deben utilizarse para resolver rutas y cargar metadatos.

Ejemplo:

```text
alex/alex.json
alex/alex_spritesheet.png
```

## 4. Especificación de sprites

Todos los personajes utilizan:

```text
frameWidth  = 32 px
frameHeight = 32 px
```

Cada sprite sheet está organizado en:

```text
4 columnas × 8 filas
```

Orden de filas:

```text
fila 0 -> idle
fila 1 -> walk
fila 2 -> work
fila 3 -> typing
fila 4 -> talk
fila 5 -> point
fila 6 -> celebrate
fila 7 -> sit
```

Cada animación tiene 4 frames.

Por tanto:

```text
ancho sprite sheet = 128 px
alto sprite sheet  = 256 px
```

## 5. Animaciones disponibles

- `idle`: reposo.
- `walk`: desplazamiento.
- `work`: trabajo frente a computador.
- `typing`: escritura/programación.
- `talk`: diálogo o interacción.
- `point`: señalar o presentar.
- `celebrate`: éxito o tarea finalizada.
- `sit`: personaje sentado.

La animación `walk` no desplaza automáticamente al personaje. La lógica de movimiento debe modificar `x` e `y` en la aplicación.

## 6. Uso del archivo JSON

Cada personaje incluye un JSON similar a:

```json
{
  "name": "alex",
  "displayName": "Alex",
  "role": "Software Developer",
  "image": "alex_spritesheet.png",
  "frameWidth": 32,
  "frameHeight": 32,
  "sheetWidth": 128,
  "sheetHeight": 256,
  "animations": {
    "idle": {
      "row": 0,
      "frames": 4,
      "fps": 4,
      "loop": true
    },
    "walk": {
      "row": 1,
      "frames": 4,
      "fps": 9,
      "loop": true
    }
  }
}
```

El JSON debe considerarse la **fuente de verdad** para:

- FPS;
- fila de cada animación;
- cantidad de frames;
- loop;
- dimensiones del frame.

No codificar manualmente estos valores cuando puedan obtenerse del JSON.

## 7. Cálculo del frame en el sprite sheet

Para cualquier animación:

```text
sx = frameIndex * frameWidth
sy = animation.row * frameHeight
```

Ejemplo para `walk`, fila 1, frame 2:

```text
sx = 2 × 32 = 64
sy = 1 × 32 = 32
```

Rectángulo fuente:

```text
x = 64
y = 32
width = 32
height = 32
```

## 8. Renderizado en Canvas

```javascript
ctx.imageSmoothingEnabled = false;

ctx.drawImage(
  image,
  sourceX,
  sourceY,
  frameWidth,
  frameHeight,
  screenX,
  screenY,
  frameWidth * scale,
  frameHeight * scale
);
```

CSS recomendado:

```css
canvas,
.pixel-character {
  image-rendering: pixelated;
}
```

## 9. Regla crítica: escalado pixel-perfect

Utilizar escalas enteras:

```text
1× = 32 × 32
2× = 64 × 64
3× = 96 × 96
4× = 128 × 128
```

Evitar escalas fraccionarias como:

```text
1.5×
2.25×
```

No utilizar:

```text
bilinear filtering
bicubic filtering
anti-aliasing
```

## 10. Reproductor JavaScript incluido

El paquete contiene:

```text
pixel_office_player.js
```

Uso:

```javascript
const meta = await fetch("./alex/alex.json")
  .then(r => r.json());

const alex = new PixelOfficeCharacter(
  "./alex/alex_spritesheet.png",
  meta,
  4
);

alex.setAnimation("walk");
alex.update(deltaMs);
alex.draw(ctx, x, y);
```

## 11. Bucle de animación

```javascript
let lastTime = performance.now();

function gameLoop(currentTime) {
  const deltaMs = currentTime - lastTime;
  lastTime = currentTime;

  character.update(deltaMs);
  character.draw(ctx, character.x, character.y);

  requestAnimationFrame(gameLoop);
}

requestAnimationFrame(gameLoop);
```

Usar siempre `deltaTime`; no asumir 60 FPS constantes.

## 12. Máquina de estados recomendada

```javascript
const CharacterState = {
  IDLE: "idle",
  WALK: "walk",
  WORK: "work",
  TYPING: "typing",
  TALK: "talk",
  POINT: "point",
  CELEBRATE: "celebrate",
  SIT: "sit"
};
```

Ejemplo de secuencia:

```text
IDLE
 ↓
WALK
 ↓
SIT
 ↓
WORK
 ↓
TYPING
 ↓
CELEBRATE
 ↓
IDLE
```

## 13. Comportamiento autónomo sugerido

```javascript
async function runOfficeRoutine(character) {
  character.setAnimation("walk");
  await moveTo(character, deskPosition);

  character.setAnimation("sit");
  await wait(1000);

  character.setAnimation("typing");
  await wait(5000);

  character.setAnimation("celebrate");
  await wait(1000);

  character.setAnimation("idle");
}
```

## 14. Movimiento

```javascript
if (character.state === "walk") {
  character.x += character.speed * deltaSeconds;
}
```

Cuando llegue al destino:

```javascript
character.setAnimation("idle");
```

## 15. Orientación izquierda/derecha

Puede espejarse el sprite en Canvas:

```javascript
ctx.save();

ctx.translate(x + width, y);
ctx.scale(-1, 1);

ctx.drawImage(
  sprite,
  sx,
  sy,
  32,
  32,
  0,
  0,
  width,
  height
);

ctx.restore();
```

No duplicar assets para izquierda/derecha salvo necesidad explícita.

## 16. Posición lógica

Cada agente debería mantener al menos:

```javascript
{
  x: 100,
  y: 200,
  targetX: 300,
  targetY: 200,
  speed: 60
}
```

Separar siempre:

```text
posición
animación
estado
rol
tarea
```

## 17. Colisiones

No usar los 32×32 px completos como hitbox.

Recomendación:

```text
collisionWidth  ≈ 14 px
collisionHeight ≈ 10 px
```

Ubicar la caja alrededor de los pies.

Ejemplo:

```javascript
character.collision = {
  x: character.x + 9,
  y: character.y + 22,
  width: 14,
  height: 10
};
```

## 18. Orden de renderizado

Para una escena tipo oficina, utilizar **Y-sorting**:

```javascript
entities.sort((a, b) => a.y - b.y);
```

Así los personajes pueden pasar visualmente delante o detrás de muebles.

## 19. Integración con escritorios

Secuencia sugerida:

```text
walk
 ↓
sit
 ↓
work
 ↓
typing
```

Cada escritorio puede definir:

```javascript
{
  x: 400,
  y: 220,
  characterAnchor: {
    x: 382,
    y: 207
  }
}
```

Al llegar:

```javascript
character.x = desk.characterAnchor.x;
character.y = desk.characterAnchor.y;
```

## 20. Uso de retratos

Archivos:

```text
alex_portrait.png
marcus_portrait.png
sophia_portrait.png
elena_portrait.png
```

Usarlos para:

- perfiles;
- chat;
- selección de personajes;
- panel de empleados;
- notificaciones;
- diálogo.

No usarlos como sprites dentro del escenario.

## 21. Uso de GIF

Los archivos `*_preview.gif` son solo para:

- preview;
- documentación;
- validación visual.

No usar GIF como mecanismo principal de runtime.

Usar:

```text
spritesheet + JSON
```

## 22. Frames individuales

También existen:

```text
frames/<animation>/00.png
frames/<animation>/01.png
frames/<animation>/02.png
frames/<animation>/03.png
```

Sirven para motores que trabajen mejor con frames separados.

Ejemplos:

```text
Godot -> AnimatedSprite2D
Unity -> AnimationClip
React -> <img>
```

## 23. Uso del manifest general

`characters_manifest.json` permite cargar todos los personajes dinámicamente.

```javascript
const manifest =
  await fetch("./characters_manifest.json")
  .then(r => r.json());

for (const id of Object.keys(manifest.characters)) {
  const path = manifest.characters[id].path;
  // cargar personaje
}
```

No codificar la lista de personajes manualmente si puede usarse el manifest.

## 24. Integración con Phaser

```javascript
this.load.spritesheet(
  "alex",
  "alex/alex_spritesheet.png",
  {
    frameWidth: 32,
    frameHeight: 32
  }
);
```

Como hay 4 frames por fila:

```text
globalFrame = row * 4 + localFrame
```

Ejemplo para `walk`:

```javascript
this.anims.create({
  key: "alex-walk",
  frames: this.anims.generateFrameNumbers(
    "alex",
    {
      start: 4,
      end: 7
    }
  ),
  frameRate: 9,
  repeat: -1
});
```

## 25. Integración con Godot

Usar:

```text
AnimatedSprite2D
```

Configuración:

```text
Hframes = 4
Vframes = 8
```

Filas:

```text
idle      fila 0
walk      fila 1
work      fila 2
typing    fila 3
talk      fila 4
point     fila 5
celebrate fila 6
sit       fila 7
```

## 26. Integración con Unity

Importar con:

```text
Sprite Mode: Multiple
Pixels Per Unit: 32
Filter Mode: Point (no filter)
Compression: None
```

En Sprite Editor:

```text
Grid by Cell Size
32 × 32
```

## 27. Convenciones

Mantener IDs en minúsculas:

```text
alex
marcus
sophia
elena
```

Animaciones:

```text
idle
walk
work
typing
talk
point
celebrate
sit
```

No renombrar sin actualizar también:

- JSON;
- manifest;
- rutas;
- código.

## 28. Reglas que el agente no debe romper

No modificar `32×32 px` por frame sin regenerar también:

```text
JSON
sprite sheet
código de carga
```

No alterar arbitrariamente:

- orden de filas;
- orden de frames;
- FPS;
- comportamiento de loop.

No reemplazar `spritesheet + JSON` por GIF.

No usar escalado fraccionario.

## 29. Flujo recomendado para un agente implementador

```text
1. Leer characters_manifest.json
2. Seleccionar personaje
3. Cargar <character>.json
4. Cargar <character>_spritesheet.png
5. Crear entidad lógica
6. Asignar posición
7. Inicializar idle
8. Ejecutar update(deltaTime)
9. Seleccionar frame
10. Dibujar con nearest-neighbor
11. Cambiar estado según eventos
12. Aplicar movimiento
13. Ordenar por Y
14. Renderizar
```

## 30. Arquitectura recomendada

```text
CharacterAsset
     ↓
CharacterAnimator
     ↓
OfficeAgent
     ↓
TaskController
     ↓
OfficeWorld
```

### CharacterAsset

Responsable de:

```text
PNG
JSON
frames
```

### CharacterAnimator

Responsable de:

```text
FPS
frame actual
loop
estado gráfico
```

### OfficeAgent

Responsable de:

```text
posición
movimiento
estado
```

### TaskController

Responsable de:

```text
trabajar
caminar
hablar
reunirse
esperar
```

### OfficeWorld

Responsable de:

```text
mapa
muebles
colisiones
Y-sorting
renderizado
```

## 31. Verificación mínima

Antes de considerar terminada la integración:

```text
[ ] todos los PNG cargan
[ ] todos los JSON cargan
[ ] frameWidth = 32
[ ] frameHeight = 32
[ ] 4 frames por animación
[ ] 8 animaciones
[ ] fondo transparente
[ ] imageSmoothingEnabled = false
[ ] idle funciona
[ ] walk funciona
[ ] work funciona
[ ] typing funciona
[ ] talk funciona
[ ] point funciona
[ ] celebrate funciona
[ ] sit funciona
[ ] movimiento y animación están desacoplados
[ ] Y-sorting funciona
```

## 32. Prioridades para el agente

En caso de duda:

1. respetar el JSON;
2. preservar 32×32 px;
3. preservar pixel-perfect rendering;
4. utilizar sprite sheets para runtime;
5. utilizar frames individuales solo cuando el framework lo requiera;
6. no modificar los assets originales sin instrucción explícita.

## 33. Resumen operativo

```text
manifest
   ↓
character.json
   ↓
spritesheet.png
   ↓
animator
   ↓
state machine
   ↓
movement
   ↓
render
```

La aplicación debe usar siempre el JSON como fuente de verdad para FPS, filas, cantidad de frames, loop y dimensiones.
