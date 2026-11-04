# worktrees Specification

## Purpose
Soporte de primera clase para git worktrees: el índice de cada path consultado describe el
working tree de ese path, se siembra desde el checkout principal y se refresca solo, sin
`trail build` manual y sin exigir que el checkout principal permanezca en una rama concreta.

## Requirements

### Requirement: Seed del índice al consultar desde un worktree

Cuando una consulta llega a un worktree enlazado (`.git` es archivo, no directorio) sin índice
propio, el sistema SHALL copiar desde el checkout principal el grafo léxico, los archivos de
cache sembrables y `embeddings.db`, y a continuación parchear los archivos que difieren entre
la rama del principal y la rama del worktree. La consulta SHALL responder sobre el working
tree del worktree, no sobre la rama del principal.

#### Scenario: Primera consulta en un worktree recién creado

GIVEN un repositorio indexado y un worktree nuevo creado con `git worktree add` sobre otra rama
WHEN se ejecuta la primera consulta (`trail ask` o tool MCP) desde el worktree
THEN el worktree queda con índice propio sembrado y parcheado, y la respuesta refleja el
código de la rama del worktree

#### Scenario: Búsqueda semántica disponible desde el primer uso en el worktree

GIVEN un checkout principal con `embeddings.db` construido
WHEN se consulta `trail_search_semantic` desde un worktree recién sembrado
THEN la búsqueda responde con resultados, sin error `Embeddings DB not found`

### Requirement: Refresco automático del índice al detectar drift

Toda consulta (tools MCP y comandos CLI de búsqueda) SHALL detectar el drift entre el índice y
el working tree del path consultado: hasta 50 archivos se re-extraen inline antes de responder;
más de 50 disparan rebuild en background con la advertencia
`[stale: N files changed, rebuilding in background]` antepuesta al resultado. Razón: el
`trail build` manual post-merge era el paso más olvidado del flujo.

#### Scenario: Drift acotado se parchea inline

GIVEN un repositorio indexado donde se modificó 1 archivo después del último build
WHEN se ejecuta una consulta léxica
THEN la respuesta refleja el contenido actual del archivo modificado y no incluye advertencia
de stale

#### Scenario: Drift grande responde con advertencia y repara en background

GIVEN un repositorio indexado donde difieren 51 o más archivos respecto del índice
WHEN se ejecuta una consulta léxica
THEN la respuesta llega sin bloquear por el rebuild completo, incluye la advertencia
`[stale: ...]`, y una consulta posterior al término del rebuild responde fresca sin advertencia

### Requirement: El refresco inline no carga el modelo de embeddings

El parche inline por drift SHALL actualizar solo el grafo léxico. La actualización del índice
semántico SHALL ejecutarse en background. Razón: cargar el modelo ONNX cuesta segundos y
bloquearía consultas léxicas que no lo necesitan.

#### Scenario: Consulta léxica con drift no paga el costo del modelo

GIVEN un repositorio con drift de 1 archivo
WHEN se ejecuta `trail_find_code`
THEN la consulta no inicializa el pipeline de embeddings en el proceso que responde

### Requirement: Un worktree enlazado no es un repositorio del workspace

El descubrimiento de children de un workspace SHALL excluir los directorios cuyo `.git` es un
archivo (worktree enlazado). El conteo de repos de `trail status` y la federación de búsquedas
SHALL contar cada repositorio una sola vez aunque tenga worktrees vivos.

#### Scenario: Workspace con un worktree activo

GIVEN un workspace con el repo `backend` y un worktree `backend/.worktrees/tarea-x`
WHEN se reconstruye el workspace y se consulta `trail status`
THEN `backend` aparece una vez y el worktree no aparece como repo independiente
