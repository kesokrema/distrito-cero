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
| Saltar o frenar el vehículo | Espacio |
| Usar el arma equipada | Clic o botón táctil |
| Cambiar de arma | 1 a 6; rueda en primera persona; barra de equipo |
| Recargar | R |
| Usar botiquín | Q |
| Recoger, entrar o salir de un vehículo, usar un interior, negociar, hablar o vendar a un civil | E; USAR en pantalla táctil; X en mando Xbox |
| Subir o bajar de planta | Caminar por las escaleras laterales y sus descansos |
| Mostrar u ocultar equipo | Tab |
| Acercar o alejar cámara | Rueda del ratón |
| Elegir vista isométrica, perspectiva 3D o primera persona | Botón «VISTA» o tecla V |
| Girar cámara y mirar arriba o abajo en 3D | Arrastrar con botón derecho en perspectiva 3D. En primera persona se captura el ratón; el primer clic para recuperarlo no dispara. Si el navegador no permite capturarlo, usa botón derecho y arrastra. Escape libera el ratón y pausa. |
| Desplazar cámara isométrica | Arrastrar con botón central |
| Volver a la cámara inicial | C |
| Mover la cámara en pantalla táctil | Arrastrar para desplazar la vista isométrica o mirar en 3D; pellizcar para acercar; botón «⌖» para centrar |
| Mostrar todas las armas | Botón «☷» del equipo |
| Mostrar controles y elegir calidad automática/baja/media/alta | H o botón «?» |
| Pausa | Escape |
| Nueva ciudad | N |

## Ciudad y simulación

Los civiles tienen una identidad y rasgos estables para cada semilla: sociabilidad, empatía, valentía, paciencia, curiosidad, ritmo, mano dominante y masa. Sus necesidades de descanso y compañía, la hora y los lugares disponibles influyen en sus destinos. Pueden acercarse para conversar, alternar gestos entre hablante y oyente y reconocer vecinos con quienes han hablado. Las miradas siguen a personas y sucesos del mundo, con pausas y límites de giro.

Acércate a una persona y usa **E / USAR / X** para saludar o prestar primeros auxilios. Un vendaje consume un botiquín, detiene una hemorragia y conserva las lesiones; no regenera miembros ni revierte una herida mortal. Algunos civiles pueden usar su propio vendaje para ayudar tras un intervalo sin amenazas. Reconocer al agresor requiere una línea despejada: oír un disparo no identifica por sí solo al jugador. Los recuerdos de amenazas no desaparecen repitiendo saludos. Los recuerdos y vínculos viven durante la sesión del NPC; todavía no se guardan en una partida persistente.

Las decisiones detalladas se limitan a 48 metros del jugador, con un máximo de diez personas que piensan por actualización y pausas de 0,55–0,75 segundos entre decisiones. `?debug` expone `__cityDebug.npcs.life.stats` para medir esa capa sin añadir paneles al juego. Las colisiones mantienen el paso habitual: los impactos desplazan al personaje mediante barridos del volumen corporal, el peso afecta al empuje y la recuperación articulada es gradual. El ragdoll distribuye las correcciones por masa y espera al contacto y reposo antes de levantarse.

- Manzanas de distintas dimensiones con calles conectadas, aceras con mobiliario variado, árboles, paradas, jardineras y pequeños detalles por distrito, y parques de césped con senderos, bancos y estanques. Hay varios parques tanto cerca del inicio como en los distritos exteriores. Las manzanas próximas se generan durante el desplazamiento; las lejanas dejan de dibujarse.
- La arquitectura usa voxels de 0,44 unidades; los personajes y detalles usan 0,22. Ambas escalas encajan en la misma cuadrícula. Cada celda de la calle mide diez voxels de lado. Las medidas de diseño se redondean a cubos completos; los rótulos son mosaicos de esos mismos cubos con letras impresas. Los anillos de efectos y los marcadores flotantes son indicadores visuales, no piezas físicas del mundo.
- Casas, apartamentos, hoteles, comercios, talleres y fábricas con varios tamaños, alturas, cubiertas, entradas, escaparates y detalles de fachada.
- Interiores transitables con muros y cubiertas de una capa de voxels pequeños, puertas abiertas, acabados propios, mobiliario y escaleras. Los edificios de más altura tienen dos o tres plantas jugables y acciones distintas según su uso. Las plantas y cubiertas conservan su visibilidad; los interiores de manzanas lejanas se suspenden según la distancia.
- Diez clases de vehículos distribuidas por las calles: automóvil, compacto, taxi, furgoneta, camioneta, todoterreno, autobús, camión, ambulancia y motoneta. Cada calle mantiene un sentido de circulación estable; el tráfico circula por el carril libre y toma curvas en los cruces según el sentido de la calle de destino. Los vehículos estacionados ocupan el borde de la calle y pueden conducirse. La dirección del vehículo del jugador gira de forma gradual según la velocidad. Los autos conducidos y los del tráfico pueden atropellar NPC; los choques propagan el pánico. El vehículo del jugador también se detiene al topar con otro auto.
- Civiles distribuidos por manzana y distrito, con hogares y destinos junto a entradas reales, posiciones de espera repartidas, rutas calculadas en un Web Worker, pausas y encuentros breves. La marcha y la carrera usan zancadas ligadas a la velocidad y articulaciones amortiguadas; también reaccionan con susto, tropiezo y búsqueda de resguardo. Se apartan entre sí y recalculan sus caminos cuando aparecen obstáculos. Los impactos los derriban con un cuerpo físico temporal: se levantan si conservan ambas piernas; el daño repetido en un segmento lo marca en rojo y puede desprenderlo. Los enemigos con fusil usan ambas manos, flanquean y disparan desde más distancia.
- Oclusión ambiental en pantalla, sombras suaves e iluminación cálida para dar profundidad a fachadas, árboles e interiores. Los disparos afectan voxels concretos y las cargas destruyen un volumen en torno a la altura donde impactan.
- Un encargo de suministros que conduce al refugio del parque. El combate, la conducción y la demolición forman parte del recorrido, sin obligar a destruir la ciudad para completar el encargo.

## Arquitectura

`GridSystem` gestiona la trama y la transitabilidad; `VoxelSystem` define la unidad y las piezas compartidas; `PrefabManager` genera y dibuja las manzanas; `DestructionSystem` maneja módulos y escombros; `NPCController` coordina civiles y enemigos; `LocomotionIK` anima al jugador; `VehicleSystem` maneja conducción y atropellos; `InteriorSystem` gestiona los usos de los edificios; `RenderEngine` controla cámara, luces y renderizado; `EventBus` distribuye los cambios; `path.worker.ts` calcula las rutas A*.

## Límites actuales

La generación se realiza a demanda dentro de una cuadrícula lógica finita de 1.025 × 1.025 celdas (aproximadamente 2,25 km de lado). No se crean las celdas de todo ese espacio al iniciar. Cada planta representada por la fachada tiene suelo y acceso físico por escaleras. Las físicas de escombros son cinemáticas y el tráfico automático usa decisiones de carril sencillas. El personaje usa una cápsula barrida contra la ocupación lógica de paredes, suelos, techos, objetos y vehículos orientados. La cuadrícula sigue delimitando navegación y zonas preparadas. Las piezas inclinadas dañadas se aproximan mediante cajas voxel; los vehículos conservan un volumen de contacto simplificado.


## Generación y presupuesto de ciudad

- `BuildingLayout` divide cada manzana en parcelas antes de construir. Coloca uno o dos frentes hacia las calles norte/sur, con separación entre edificios, patios y pasos reservados. El catálogo de usos elige alturas y mobiliario; las escaleras tienen una zona reservada que comparten los huecos de todas las plantas.
- Fachadas con puertas físicamente abiertas, huecos y ventanas en las mismas coordenadas voxel, cornisas a la altura de cada planta, toldos sobre el paso y una única cubierta con equipos apoyados en ella.
- Los módulos arquitectónicos guardan voxels individuales de 0,44 unidades. El worker une sus caras expuestas contiguas por material y propietario (greedy meshing). Un disparo calcula el voxel a partir del punto de impacto, aunque la cara visible sea un rectángulo grande.
- El suelo usa una superficie por celda y una textura por manzana con un píxel por voxel, incluidas marcas viales. Evita cien matrices y cien superficies por celda; los bordillos conservan su relieve.
- La carga inicial muestra su progreso y cede el control al navegador entre etapas, con un presupuesto de 8 ms por llamada. Durante el juego se generan manzanas por etapas con un presupuesto objetivo de 2 ms por llamada. Una etapa individual puede superar ese presupuesto; no es una garantía rígida de tiempo de cuadro. Las paredes se construyen directamente en el worker, sin crear antes una versión completa con cubos instanciados.
- La visibilidad usa el encuadre y la distancia, manteniendo siempre activo el vecindario inmediato del jugador aunque mire hacia otro lado. Al salir del radio se liberan las superficies de los edificios y los recursos exclusivos del suelo en la GPU. Los interiores cercanos, el tráfico y los peatones usan radios de actividad propios.
- Peldaños, suelos y piezas repetidas comparten geometrías y se instancian por grupo. Los objetos intactos comparten máscaras/vida; se copian únicamente al recibir daño. La estructura lógica de las zonas visitadas sigue en memoria para conservar cambios al volver. Todavía no existe descarga completa de esa estructura a disco: no es un mundo infinito ni una prueba de memoria constante durante recorridos ilimitados.
- A* usa un heap y un índice de celdas transitables generadas. No crea cuatro matrices del tamaño del mundo por cada ruta.

## Comprobaciones

`npm test` comprueba parcelas y accesos en 1.470 manzanas de 30 semillas, continuidad de superficies, huecos por destrucción, rutas con obstáculos, acceso por escaleras entre plantas y carga/descarga gráfica conservando daños. `npm run build` comprueba tipos y genera la distribución.

Las pruebas comprueban la reducción de caras y la conservación de huecos, alturas y propietarios de daño. Las cifras de triángulos describen geometría y no son una medición de FPS. `PrefabManager.streamingStats()` permite repetir la comparación sin agregar paneles al HUD.

## Estabilidad y medición de rendimiento

El movimiento y los contactos avanzan a 60 Hz, con un máximo de cuatro pasos de recuperación por fotograma e interpolación visual; las decisiones de tráfico y NPCs avanzan a 30 Hz. Al pausar, perder foco o esconder la pestaña se limpian las entradas retenidas y el acumulador. Bajo una carga extrema se descarta tiempo de recuperación para evitar una espiral de trabajo; el diagnóstico informa cuánto se ha descartado.

La cámara usa un volumen de seguridad, comprueba el espacio de la cabeza y suaviza cambios de altura. El arma se dibuja con su propia cámara; los disparos en primera persona usan el origen de la cámara del mundo. Los rayos incluyen interiores comprimidos y descartan voxels ya destruidos mientras llega la malla nueva. Los escombros pequeños siguen siendo partículas visuales: esta revisión no incorpora AVBD ni convierte toda la ciudad en cuerpos rígidos.

Tres workers calculan superficies de edificios, decoración y pavimento. Los resultados llevan revisión y se aplican de forma acotada; una respuesta antigua no repone daño reciente. Durante ese intervalo, las colisiones leen las máscaras actuales. Los cuerpos en reposo pueden dormir y despiertan por impactos o cambios del terreno. Los NPCs retirados liberan sus registros de instancias y animaciones; las zonas visitadas conservan sus datos lógicos para mantener el daño al volver.

Para comparar en hardware real, usa la compilación de producción (`npm run build` y `npm run preview`) con `?seed=828507&time=12&debug&quality=high`. Mantén navegador, resolución, escala de pantalla y calidad iguales entre versiones. Espera a `__cityDebug.prefabs.pendingWork === 0` y repite el mismo recorrido: giro en primera persona, calle, entrada, escaleras, vehículo y destrucción. Distingue la carga inicial de las zonas ya preparadas.

En la consola del navegador:

```js
await __cityDebug.sample(15);
copy(JSON.stringify(__cityDebug.snapshot(), null, 2));
```

El resultado incluye dispositivo, calidad, carga inicial, memoria gráfica, llamadas de dibujo y tiempos p50/p95/p99 de las últimas 600 muestras por categoría. `render` mide CPU al enviar el dibujo; `gpu` usa consultas GPU asíncronas cuando el navegador permite esa extensión. Una GPU por software, como SwiftShader, no sirve para certificar FPS de una GPU física. Los objetivos de 60 FPS en PC y 30 FPS en móvil se deben contrastar en los dispositivos de referencia.

Las regresiones incluyen barridos contra paredes finas, deslizamiento, escalones con poco espacio para la cabeza, techos, caída, destrucción, cámaras, consistencia a 30/60/120 FPS, clonación de mensajes de workers, carga al volver a una zona, reposo de cuerpos y cambios sostenidos de calidad.
