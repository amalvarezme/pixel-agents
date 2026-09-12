# Pixel Office Characters

Paquete de sprites 2D para aplicaciones tipo **Pixel Office**.

## Personajes

- **Alex** — Software Developer
- **Marcus** — IT / DevOps Engineer
- **Sophia** — UX/UI Designer
- **Elena** — Data Scientist / AI Engineer

## Formato

- Frame: **32×32 px**
- Fondo: transparente (RGBA)
- Sprite sheet: **4 columnas × 8 filas**
- Orden de filas: idle, walk, work, typing, talk, point, celebrate, sit
- Escalado recomendado: múltiplos enteros (2×, 3×, 4×) con `imageSmoothingEnabled = false`.

Cada carpeta contiene:

- `<personaje>_spritesheet.png`
- `<personaje>.json`
- `<personaje>_preview.gif`
- `<personaje>_portrait.png`
- `frames/<animación>/00.png ...`

## Animaciones

- `idle` — 4 frames, 4 FPS, loop=true
- `walk` — 4 frames, 9 FPS, loop=true
- `work` — 4 frames, 6 FPS, loop=true
- `typing` — 4 frames, 8 FPS, loop=true
- `talk` — 4 frames, 5 FPS, loop=true
- `point` — 4 frames, 5 FPS, loop=true
- `celebrate` — 4 frames, 7 FPS, loop=false
- `sit` — 4 frames, 4 FPS, loop=true

## Coordenadas

El JSON usa filas de animación. Para una animación con `row = R` y frame `F`:

```js
sx = F * frameWidth;
sy = R * frameHeight;
```

## Reproductor web

`pixel_office_player.js` incluye una clase mínima para Canvas 2D.

```js
const meta = await fetch("./alex/alex.json").then(r => r.json());
const alex = new PixelOfficeCharacter("./alex/alex_spritesheet.png", meta, 4);

alex.setAnimation("typing");
alex.update(deltaMs);
alex.draw(ctx, 100, 100);
```

## Integración

El formato es directamente adaptable a Canvas, PixiJS, Phaser, Godot o Unity.
