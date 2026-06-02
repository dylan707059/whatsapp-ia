import type { OrderData } from "./types";
import { phoneForDisplay } from "./phone-utils";

// Construye el mensaje grande de confirmación que se envía al cliente.
// Se usa tanto para el flujo normal (después del LLM) como para /fotoconfirmar.
export function buildClientConfirmationText(data: OrderData): string {
  const firstName  = data.firstName || data.fullName.split(" ")[0] || data.fullName;
  const display    = phoneForDisplay(data.phone);
  const lastName   = data.lastName || "";

  return [
    `Hola ${firstName}, buen día 😊`,
    "",
    "Te escribimos para confirmar los datos de tu pedido antes de enviarlo. Por favor revisa que todo esté correcto:",
    "",
    `🛍️ Producto: ${data.product}`,
    `🎨 Color: ${data.color}`,
    `📏 Talla: ${data.size}`,
    `🔢 Cantidad: ${data.quantity}`,
    "",
    `💰 Total a pagar: ${data.total}`,
    `🚚 Envío: ${data.shipping || "Gratis"}`,
    `💳 Pago: ${data.payment || "Contraentrega"}`,
    "",
    `👤 Nombre: ${firstName}`,
    `👤 Apellido: ${lastName}`,
    `📞 Teléfono: ${display}`,
    "",
    `📍 Dirección: ${data.address}`,
    `🏙️ Ciudad: ${data.city}`,
    `📌 Departamento: ${data.department}`,
    "",
    "Si todo está correcto responde CONFIRMADO para despachar tu pedido. Si deseas cambiar algo, escríbenos y te ayudamos de inmediato 💛"
  ].join("\n");
}
