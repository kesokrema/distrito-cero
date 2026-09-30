# Animaciones Mixamo para los NPC voxel

El juego ya usa el esqueleto Mixamo como contrato de articulaciones. Descarga animaciones FBX de Mixamo con el mismo esqueleto y colócalas en esta carpeta. No hace falta incluir la malla del personaje: el cargador solo lee las rotaciones del esqueleto.

1. Conserva el mismo personaje de Mixamo en todas las descargas. El set inicial del proyecto se descargó con `Default Character`.
2. Descarga cada clip como `FBX Binary`, con `Skin: Without Skin`, `Frames per Second: 30` y `Keyframe Reduction: none`.
3. Para caminar y correr, activa `In Place` en Mixamo para que el clip no desplace el NPC; la navegación del juego mantiene el control de posición.
4. Guarda los archivos aquí y agrega cada uno al arreglo `clips` de `manifest.json`.

Ejemplo:

```json
{
  "clips": [
    { "id": "idle", "file": "idle.fbx", "states": ["idle"] },
    { "id": "walk", "file": "walk.fbx", "states": ["walk"] },
    { "id": "run", "file": "run.fbx", "states": ["run", "fear"] },
    { "id": "aim", "file": "rifle-aim.fbx", "states": ["aim"] },
    { "id": "fire", "file": "rifle-fire.fbx", "states": ["fire"] },
    { "id": "crouch", "file": "crouch.fbx", "states": ["crouch"] },
    { "id": "surrender", "file": "hands-up.fbx", "states": ["surrender"] }
  ]
}
```

Estados admitidos: `idle`, `walk`, `run`, `fear`, `aim`, `fire`, `crouch` y `surrender`. Si falta un estado, se usa el clip más cercano disponible; si todavía no hay clips, continúa la animación procedural actual.

El adaptador copia rotaciones de cadera, columna, cuello, cabeza, brazos, antebrazos, manos, muslos, piernas y pies a los grupos voxel equivalentes. Ignora la traslación de raíz para que la IA conserve el control de navegación. El ragdoll sigue siendo dueño de la pose durante las caídas y los impactos.

Para comprobar un FBX descargado contra el rig y el retargeter: `MIXAMO_TEST_FBX=/ruta/al/clip.fbx npm test`. Esta prueba valida que el archivo se abra, que se conviertan huesos y que el clip mueva articulaciones del personaje voxel.

## Arrastre herido

`crawl.fbx` es el archivo **Crawling** descargado de Mixamo. `node scripts/bake-crawl.mjs` convierte sus posiciones articulares a las longitudes de este personaje y guarda `crawl-motion.json` (54 cuadros, 1,8 segundos). El ragdoll carga esta tabla una vez y la usa como objetivos articulares durante el arrastre; la traslación, el contacto con el suelo, las colisiones y las extremidades ausentes siguen bajo control físico. No se crea un mezclador FBX por herido. El movimiento procedural solo es un respaldo mientras carga el archivo o si la descarga falla.
