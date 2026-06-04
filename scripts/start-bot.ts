// Arranque del bot como proceso independiente (modo local / standalone).
// En Render ahora el bot corre dentro del proceso de Next (ver src/instrumentation.ts),
// así que este script ya no se usa en producción — se mantiene para desarrollo.
import "./env-loader";
import { startBotRuntime } from "../src/lib/bot-runtime";

startBotRuntime();
