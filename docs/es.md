# Shinobi

Trae a Gladys las cámaras de un servidor [Shinobi](https://shinobi.video/) (el grabador de vídeo en
red autoalojado): su imagen, el movimiento que detecta Shinobi, los objetos vistos por un plugin de
detección de objetos, su modo (vigilancia, grabación, desactivada) y si están en línea. Las
detecciones en directo de Shinobi inician escenas, con la imagen del momento, que una escena puede
enviarle. Las escenas también pueden poner una cámara en grabación, o devolverla a solo vigilancia.

Probada con un servidor Shinobi real en Docker (la imagen oficial de octubre de 2026), una cámara de
red simulada y la detección de movimiento integrada de Shinobi, todavía no en una instalación en
servicio con cámaras reales, ni con un plugin de detección de objetos: sus comentarios son
bienvenidos en [GitHub](https://github.com/guim31/gladys-shinobi/issues) o en el foro de Gladys.

## Lo que necesita

- Gladys 5.1 o posterior.
- Shinobi, accesible desde Gladys en su puerto web (8080 por defecto). Es mejor un Shinobi al día:
  las detecciones en directo se probaron con el Shinobi de octubre de 2026.
- Las cámaras (monitores) ya añadidas en Shinobi, con:
  - la **API JPEG** activada (ajustes del monitor, sección JPEG API): Gladys lee allí las imágenes;
  - el **detector** activado, con la detección de movimiento integrada de Shinobi, para
    **Movimiento**;
  - un plugin de detección de objetos (Tensorflow, YOLO, DeepStack…) conectado a Shinobi y la
    detección de objetos activada para el monitor, para **Objeto detectado**. El detector integrado de
    Shinobi solo ve movimiento.
- Una **clave de API** de su cuenta de Shinobi. En Shinobi, haga clic en su nombre de usuario (arriba
  a la izquierda), luego en **API**, y añada una clave: IP `0.0.0.0` (o la dirección de Gladys), con
  los permisos para ver y controlar los monitores, ver las instantáneas, y **Can Authenticate
  Websocket** (detecciones en directo).
- La **clave de grupo** de su cuenta: en Shinobi, su nombre de usuario y luego **Ajustes** (Group
  Key).

## Instalación

1. En Gladys, abra **Integraciones**, busque **Shinobi** e instálela.
2. En su pestaña **Configuración**, rellene:
   - **Dirección de Shinobi**: la dirección del ordenador donde se ejecuta Shinobi, p. ej.
     `192.168.1.20`. Sin puerto, se usa el 8080; añada `:puerto` si se cambió, o `https://` detrás
     de un proxy inverso.
   - **Clave de API** y **Clave de grupo**: véase más arriba.
   - **Actualización de imágenes**: con qué frecuencia se envía la imagen de cada cámara a Gladys (de
     10 segundos a 15 minutos, 1 minuto por defecto). Una detección también envía una al instante.
   - **Fin de una detección**: Shinobi envía cada detección, nunca su fin. **Movimiento** y **Objeto
     detectado** vuelven a 0 tras este plazo sin una nueva detección (30 segundos por defecto). Los
     disparadores siguen el mismo plazo: una detección vuelve a iniciar una escena una vez pasado.
   - **Idioma de los nombres**: el idioma de los nombres de funciones dados al añadir una cámara.
3. Guarde y abra la pestaña **Descubrir**: un dispositivo por cámara. Añada las que quiera.
4. **Comprobar la conexión** muestra lo que lee la integración: si llegan detecciones en directo,
   cada cámara, su modo, si está en línea, y lo que falta (API JPEG desactivada, sin detector).

## Los dispositivos de Gladys

Cada monitor de Shinobi se convierte en una cámara de Gladys, con el nombre de Shinobi, con:

| Función              | Qué es                                                                           |
| -------------------- | -------------------------------------------------------------------------------- |
| **Imagen**           | La imagen de la cámara, enviada al ritmo elegido y al instante en una detección. |
| **Movimiento**       | 1 cuando el detector de movimiento de Shinobi acaba de ver movimiento, si no 0.  |
| **Objeto detectado** | 1 cuando un plugin acaba de ver un objeto, si no 0. Si el monitor lo tiene.      |
| **Modo**             | Solo vigilancia, Grabación, En reposo o Desactivada. Una lista: modificable.     |
| **En línea**         | 1 cuando el monitor funciona y llega su flujo, si no 0.                          |

Una cámara cuyo flujo se ha perdido aparece como inaccesible en Gladys. **Modo** es una lista a
propósito, nunca un interruptor que un asistente de voz accionaría por error; **En línea** es de solo
lectura. Una instantánea de Shinobi demasiado pesada se reduce en la integración para caber en Gladys
(150 KB por imagen).

## Widget del panel

**Cámara Shinobi** muestra la imagen de una cámara, el movimiento, los objetos vistos hace un momento
(p. ej. «person, car»), el modo y si está en línea, y dos botones: **Grabar** (o **Solo vigilancia**
mientras graba) y **Nueva imagen**.

## Escenas

### Disparadores

- **Shinobi: movimiento detectado**: el detector de movimiento de Shinobi ve movimiento en una
  cámara. Filtros: la cámara (vacío = todas) y la región (un nombre de región dibujada en Shinobi,
  vacío = todas). Variables: el nombre de la cámara, la región (vacía para toda la imagen) y la
  confianza en % (la parte de la imagen que cambió). La imagen del momento se envía primero a Gladys.
- **Shinobi: objeto detectado**: un plugin de detección de objetos ve un objeto. Filtros: la cámara y
  el objeto (etiqueta, como la nombra el plugin: `person`, `car`, `dog`…). Variables: el nombre de la
  cámara, el objeto y la confianza en %. Un evento por objeto visto.
- **Shinobi: cámara sin conexión**: una cámara en vigilancia o grabación pierde su flujo durante 30
  segundos, o el propio Shinobi deja de responder. No se dispara para una cámara desactivada o en
  reposo en Shinobi, ni para el reinicio que sigue a un cambio de modo.

### Acciones

- **Shinobi: grabar o solo vigilar**: **Grabación** pone una cámara en grabación continua, **Solo
  vigilancia** la devuelve a solo vigilancia (Shinobi sigue grabando en las detecciones si el monitor
  está configurado así). La clave de API necesita el permiso para controlar los monitores.

La acción **Enviar una imagen de cámara** de Gladys envía la última imagen de una cámara: justo
después de **Shinobi: movimiento detectado** o **Shinobi: objeto detectado**, es la imagen de ese
momento.

### Ideas de escenas

- **Alguien en la puerta**: **Shinobi: objeto detectado**, cámara «Entrada», objeto `person` →
  **Enviar una imagen de cámara** de esa cámara a su teléfono, con `{{triggerEvent.data.score}}` % en
  el texto.
- **Movimiento en la entrada de coches de noche**: **Shinobi: movimiento detectado**, región
  `driveway` → encender la luz exterior cinco minutos.
- **Grabar en su ausencia**: todos salen de casa → **Shinobi: grabar o solo vigilar**, Grabación, en
  la cámara del pasillo; Solo vigilancia cuando alguien vuelve.
- **Cámara perdida**: **Shinobi: cámara sin conexión** → enviar un mensaje con el nombre de la cámara.

## Solución de problemas

- **«Shinobi no responde en esta dirección»**: abra `http://<dirección>:8080` en un navegador.
  Compruebe el puerto y que ningún cortafuegos bloquee Gladys.
- **«Algo responde, pero no como Shinobi»**: la dirección o el puerto llevan a otro servicio.
  Introduzca la dirección de Shinobi, sin ruta de página (una ruta se conserva detrás de un proxy
  inverso).
- **«Shinobi rechaza la clave de API o la clave de grupo»**: copie de nuevo ambas desde Shinobi;
  compruebe la IP permitida para la clave (`0.0.0.0` para todas).
- **«Sin detecciones en directo: dé a la clave de API el permiso Can Authenticate Websocket»**:
  modifique la clave en Shinobi (nombre de usuario → API). Sin él, los estados se leen una vez por
  minuto y ninguna detección llega a Gladys.
- **«API JPEG desactivada»**: active la API JPEG en los ajustes del monitor; sin ella, Shinobi solo
  tiene una imagen de reemplazo.
- **Movimiento se queda en 0**: el detector del monitor está desactivado, o su sensibilidad es
  demasiado alta para lo que se mueve (ajustes del detector en Shinobi). La lista de eventos de
  Shinobi muestra si detecta.
- **Un proxy inverso**: debe dejar pasar los WebSockets en `/socket.io/`.
- **Más detalles**: los registros de la integración (Integraciones → Shinobi → Registros); ponga
  `LOG_LEVEL` en `debug` para ver cada petición (nunca con la clave).

## Límites

- Sin vídeo en directo: Gladys muestra imágenes, enviadas al ritmo elegido (Gladys guarda como máximo
  12 imágenes por minuto y cámara). El directo y las grabaciones se ven en Shinobi.
- Shinobi envía las detecciones, no su fin: **Movimiento** y **Objeto detectado** siguen activos el
  plazo elegido tras la última.
- Regiones y etiquetas se filtran tal como se escriben en Shinobi: los filtros de escena solo
  comparan texto.
- Desactivar una cámara se hace con la lista **Modo** o en Shinobi, no con una acción de escena.
- Las grabaciones pasadas, el historial de eventos, el PTZ y los timelapses no están cubiertos.
- Un grupo de Shinobi (una clave de grupo) por integración.
- Desarrollada sin el hardware: sus comentarios son bienvenidos. Probada con la imagen oficial de
  Shinobi en Docker y una cámara simulada; los objetos se simularon mediante la propia API de
  Shinobi, sin plugin.

Esta integración no está afiliada a Shinobi Systems.
