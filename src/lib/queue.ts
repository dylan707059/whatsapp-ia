// Cola global FIFO para todos los procesos críticos de pedidos.
// Un pedido se procesa completo antes de empezar el siguiente.
// Sin Promise.all. Sin colas paralelas.

let orderProcessingQueue: Promise<void> = Promise.resolve();

export function enqueueOrderTask(
  taskName: string,
  task: () => Promise<void>
): void {
  orderProcessingQueue = orderProcessingQueue
    .then(async () => {
      console.log(`[bot] Iniciando tarea en cola: ${taskName}`);
      await task();
      console.log(`[bot] Tarea finalizada en cola: ${taskName}`);
    })
    .catch((err) => {
      console.error(`[bot] Error en tarea de cola ${taskName}:`, err);
    });
}
