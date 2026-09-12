# Pixel Office v2 — AI Agents at Work

Paquete listo para convertir la oficina futurista en un escenario 2D interactivo con cuatro agentes y un **Sentinel** exterior visible a través de la ventana.

## Qué cambió respecto a v1

- sprites direccionales (`down`, `up`, `side` + mirror para `left`);
- `work`, `typing` y `sit` ya no contienen escritorio, portátil ni silla;
- origen lógico en los pies y hitbox pequeña;
- escenario incorporado como `background`, `foreground` y `window_mask`;
- 11 puestos de trabajo con anchors;
- Persistent Memory Archive como zona interactiva;
- navegación A* mediante grid de 24 px y colisiones;
- Y-sorting y escalado por profundidad;
- Sentinel exterior independiente y animado;
- runtime ES Modules sin dependencias;
- demo web y script de validación.

## Inicio rápido

```bash
cd pixel_office_v2
python -m http.server 8000
```

Abrir:

```text
http://localhost:8000/05_examples/
```

La guía principal para un agente de código está en:

`06_docs/IMPLEMENTACION_AGENTE_CODIGO.md`

## Nota del escenario

`background.png` reemplaza el robot estático de la referencia por una vista de ciudad simplificada para permitir que `sentinel` sea realmente un sprite móvil. `office_source_reference.png` conserva la ilustración original.
