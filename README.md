# Distrito Cero

Prototipo jugable de exploración urbana voxel con cámaras isométrica, 3D y en primera persona, hecho con TypeScript, Three.js y Vite. La ciudad combina encargo, combate, conducción, civiles con rutinas, edificios destructibles e interiores accesibles.

## Ejecutar

```bash
npm install
npm run dev
```

Abre la dirección local que indique Vite. `npm run build` genera la versión estática en `dist/`. Usa `?seed=12345` para repetir una ciudad.

## Probar en otra PC

La versión pública se publica en [GitHub Pages](https://kesokrema.github.io/distrito-cero/) cada vez que se actualiza la rama `main`. También se publica la página de prueba del rig en `/rig-preview.html`. El flujo de GitHub Actions ejecuta `npm test` antes de publicar; si falla, conserva la versión que ya estaba en línea.

Para una copia local, clona el repositorio y ejecuta `npm ci` y `npm run dev`. GitHub Pages sirve el juego como sitio estático: no sincroniza partidas entre computadoras.

## Controles

| Acción | Control |
| --- | --- |
| Caminar o conducir | W A S D o flechas |
| Correr | Shift |
| Rodar o frenar el vehículo | Espacio |
| Usar el arma equipada | Clic o botón táctil |
| Cambiar de arma | 1 a 6; rueda en primera persona; barra de equipo |
| Recargar | R |
| Usar botiquín | Q |
| Recoger, entrar o salir de un vehículo, usar un interior, negociar | E |
| Subir o bajar de planta | Caminar por las escaleras laterales y sus descansos |
| Mostrar u ocultar equipo | Tab |
| Acercar o alejar cámara | Rueda del ratón |
| Elegir vista isométrica, perspectiva 3D o primera persona | Botón «VISTA» o tecla V |
| Girar cámara y mirar arriba o abajo en 3D | Arrastrar con botón derecho en perspectiva 3D; en primera persona basta mover el mouse sobre el juego. Al elegir esa vista se intenta capturar el puntero para girar sin límites de pantalla. |
| Desplazar cámara isométrica | Arrastrar con botón central |
| Volver a la cámara inicial | C |
| Mover la cámara en pantalla táctil | Arrastrar para desplazar la vista isométrica o mirar en 3D; pellizcar para acercar; botón «⌖» para centrar |
| Mostrar todas las armas | Botón «☷» del equipo |
| Mostrar controles | H o botón «?» |
| Pausa | Escape |
| Nueva ciudad | N |

## Ciudad y simulación

- Manzanas de distintas dimensiones con calles conectadas, aceras con mobiliario variado, árboles, paradas, jardineras y pequeños detalles por distrito, y parques de césped con senderos, bancos y estanques. Hay varios parques tanto cerca del inicio como en los distritos exteriores. Las manzanas próximas se generan durante el desplazamiento; las lejanas dejan de dibujarse.
- Una única unidad voxel de 0,22 unidades compone el suelo, los muros, los techos, los interiores, los personajes, los objetos y los vehículos. Cada celda de la calle mide diez voxels de lado. Las medidas de diseño se redondean a cubos completos; los rótulos son mosaicos de esos mismos cubos con letras impresas. Los anillos de efectos y los marcadores flotantes son indicadores visuales, no piezas físicas del mundo.
- Casas, apartamentos, hoteles, comercios, talleres y fábricas con varios tamaños, alturas, cubiertas, entradas, escaparates y detalles de fachada.
- Interiores transitables con muros y cubiertas de una capa de voxels pequeños, puertas abiertas, acabados propios, mobiliario y escaleras. Los edificios de más altura tienen dos o tres plantas jugables y acciones distintas según su uso. Las plantas y cubiertas conservan su visibilidad; los interiores de manzanas lejanas se suspenden según la distancia.
- Diez clases de vehículos distribuidas por las calles: automóvil, compacto, taxi, furgoneta, camioneta, todoterreno, autobús, camión, ambulancia y motoneta. Cada calle mantiene un sentido de circulación estable; el tráfico circula por el carril libre y toma curvas en los cruces según el sentido de la calle de destino. Los vehículos estacionados ocupan el borde de la calle y pueden conducirse. La dirección del vehículo del jugador gira de forma gradual según la velocidad. Los autos conducidos y los del tráfico pueden atropellar NPC; los choques propagan el pánico. El vehículo del jugador también se detiene al topar con otro auto.
- Civiles distribuidos por manzana y distrito, con hogares y destinos junto a entradas reales, posiciones de espera repartidas, rutas calculadas en un Web Worker, pausas y encuentros breves. La marcha y la carrera usan zancadas ligadas a la velocidad y articulaciones amortiguadas; también reaccionan con susto, tropiezo y búsqueda de resguardo. Se apartan entre sí y recalculan sus caminos cuando aparecen obstáculos. Los impactos los derriban con un cuerpo físico temporal: se levantan si conservan ambas piernas; el daño repetido en un segmento lo marca en rojo y puede desprenderlo. Los enemigos con fusil usan ambas manos, flanquean y disparan desde más distancia.
- Oclusión ambiental en pantalla, sombras suaves e iluminación cálida para dar profundidad a fachadas, árboles e interiores. Los disparos afectan voxels concretos y las cargas destruyen un volumen en torno a la altura donde impactan.
- Un encargo de suministros que conduce al refugio del parque. El combate, la conducción y la demolición forman parte del recorrido, sin obligar a destruir la ciudad para completar el encargo.

## Arquitectura

`GridSystem` gestiona la trama y la transitabilidad; `VoxelSystem` define la unidad y las piezas compartidas; `PrefabManager` genera y dibuja las manzanas; `DestructionSystem` maneja módulos y escombros; `NPCController` coordina civiles y enemigos; `LocomotionIK` anima al jugador; `VehicleSystem` maneja conducción y atropellos; `InteriorSystem` gestiona los usos de los edificios; `RenderEngine` controla cámara, luces y renderizado; `EventBus` distribuye los cambios; `path.worker.ts` calcula las rutas A*.

## Límites actuales

La generación se realiza a demanda dentro de una cuadrícula lógica finita de 1.025 × 1.025 celdas (aproximadamente 2,25 km de lado). No se crean las celdas de todo ese espacio al iniciar. Cada planta representada por la fachada tiene suelo y acceso físico por escaleras. Las físicas de escombros son cinemáticas y el tráfico automático usa decisiones de carril sencillas. La cámara en primera persona ya es jugable; las colisiones del personaje siguen usando la cuadrícula y obstáculos interiores, por lo que algunos detalles voxel pequeños todavía no tienen colisión individual.


## Generación y presupuesto de ciudad

- `BuildingLayout` divide cada manzana en parcelas antes de construir. Coloca uno o dos frentes hacia las calles norte/sur, con separación entre edificios, patios y pasos reservados. El catálogo de usos elige alturas y mobiliario; las escaleras tienen una zona reservada que comparten los huecos de todas las plantas.
- Fachadas con puertas físicamente abiertas, huecos y ventanas en las mismas coordenadas voxel, cornisas a la altura de cada planta, toldos sobre el paso y una única cubierta con equipos apoyados en ella.
- Los módulos guardan voxels individuales de 0,22 unidades. El worker une sus caras expuestas contiguas por material y propietario (greedy meshing). Un disparo calcula el voxel a partir del punto de impacto, aunque la cara visible sea un rectángulo grande.
- El suelo usa una superficie por celda y una textura por manzana con un píxel por voxel, incluidas marcas viales. Evita cien matrices y cien superficies por celda; los bordillos conservan su relieve.
- Se generan manzanas por etapas con un presupuesto objetivo de 4 ms por llamada. Una etapa individual puede superar ese presupuesto; no es una garantía rígida de tiempo de cuadro. Las paredes se construyen directamente en el worker, sin crear antes una versión completa con cubos instanciados.
- Se dibujan como máximo 25 manzanas completas alrededor del jugador. Al salir del radio se liberan las superficies de los edificios y los recursos exclusivos del suelo en la GPU. Los interiores cercanos, el tráfico y los peatones usan radios de actividad propios.
- Peldaños, suelos y piezas repetidas comparten geometrías y se instancian por grupo. Los objetos intactos comparten máscaras/vida; se copian únicamente al recibir daño. La estructura lógica de las zonas visitadas sigue en memoria para conservar cambios al volver. Todavía no existe descarga completa de esa estructura a disco: no es un mundo infinito ni una prueba de memoria constante durante recorridos ilimitados.
- A* usa un heap y un índice de celdas transitables generadas. No crea cuatro matrices del tamaño del mundo por cada ruta.

## Comprobaciones

`npm test` comprueba parcelas y accesos en 1.470 manzanas de 30 semillas, continuidad de superficies, huecos por destrucción, rutas con obstáculos, acceso por escaleras entre plantas y carga/descarga gráfica conservando daños. `npm run build` comprueba tipos y genera la distribución.

En la prueba de la semilla 919809, la malla exterior usa aproximadamente un 97,5 % menos triángulos que las mismas caras voxel sin unir; las superficies de suelo reducen sus triángulos en un 99 %. Estas cifras describen geometría y no una medición de FPS. `PrefabManager.streamingStats()` permite repetir la comparación sin agregar paneles al HUD.
