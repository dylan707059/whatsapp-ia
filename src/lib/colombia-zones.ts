// ─── Zonas no cubiertas por transportadoras estándar en Colombia ─────────────
// Departamentos donde NO realizamos envíos por restricciones logísticas:
//   - Islas, selva, zonas sin carretera nacional
//   - Cobertura nula o demasiado costosa de couriers (Servientrega, Coordinadora, etc.)
//
// Para overridear o agregar más, usar variable de entorno:
//   SHOPIFY_BLOCKED_DEPARTMENTS=San Andres y Providencia,Amazonas,Vaupes,Guainia,Vichada

const DEFAULT_BLOCKED_DEPARTMENTS = [
  // Islas
  "san andres y providencia",
  "san andres, providencia y santa catalina",
  "san andres",
  "providencia",
  "san andres islas",
  "archipielago de san andres",
  "archipielago de san andres, providencia y santa catalina",
  // Selva amazónica
  "amazonas",
  // Selva nororiental
  "vaupes",
  "guainia",
  // Llanos remotos
  "vichada"
];

// Algunas ciudades clave que también queremos rechazar aunque vengan con un
// departamento mal escrito (defensa en profundidad)
const DEFAULT_BLOCKED_CITIES = [
  // San Andrés
  "san andres",
  "providencia",
  "santa catalina",
  // Amazonas
  "leticia",
  "puerto narino",
  // Vaupés
  "mitu",
  "caruru",
  // Guainía
  "inirida",
  // Vichada
  "puerto carreno",
  "la primavera",
  "cumaribo"
];

// Códigos ISO 3166-2 (province_code) de Shopify para los departamentos
// bloqueados. Shopify a veces manda SOLO el código (ej: "VAU") sin el nombre
// completo en `province`, así que también matcheamos contra estos.
//   San Andrés y Providencia → SAP
//   Amazonas                 → AMA
//   Vaupés                   → VAU
//   Guainía                  → GUA
//   Vichada                  → VID
const DEFAULT_BLOCKED_DEPARTMENT_CODES = ["sap", "ama", "vau", "gua", "vid"];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Normaliza un nombre de zona: minúsculas, sin tildes, sin caracteres
 * especiales, espacios colapsados. Para matching robusto contra usuarios que
 * escriben "San Andrés", "san andres", "SAN ANDRES ISLAS", etc.
 */
export function normalizeZoneName(raw: string): string {
  return (raw || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")  // quitar tildes
    .replace(/[.,;:]/g, " ")           // puntuación a espacios
    .replace(/\s+/g, " ")              // colapsar espacios
    .trim();
}

function getConfiguredBlockedDepartments(): string[] {
  const envValue = (process.env.SHOPIFY_BLOCKED_DEPARTMENTS || "").trim();
  if (!envValue) return DEFAULT_BLOCKED_DEPARTMENTS;
  return envValue
    .split(",")
    .map(s => normalizeZoneName(s))
    .filter(Boolean);
}

function getConfiguredBlockedCities(): string[] {
  const envValue = (process.env.SHOPIFY_BLOCKED_CITIES || "").trim();
  if (!envValue) return DEFAULT_BLOCKED_CITIES;
  return envValue
    .split(",")
    .map(s => normalizeZoneName(s))
    .filter(Boolean);
}

function getConfiguredBlockedDepartmentCodes(): string[] {
  const envValue = (process.env.SHOPIFY_BLOCKED_DEPARTMENT_CODES || "").trim();
  if (!envValue) return DEFAULT_BLOCKED_DEPARTMENT_CODES;
  return envValue
    .split(",")
    .map(s => normalizeZoneName(s))
    .filter(Boolean);
}

// ─── Detector de envíos a oficinas (rechazo) ─────────────────────────────────
// NO realizamos envíos a oficinas de transportadoras ni a oficinas propias del
// cliente. El cliente debe poner una dirección residencial o comercial real.

const OFFICE_KEYWORDS = [
  // Genérico
  "oficina principal",
  "oficina central",
  "oficina inter",
  "ofic principal",
  "of principal",
  "oficinas inter",
  // Recoger / retirar
  "recoge en",
  "recoger en",
  "retiro en",
  "retira en",
  "recogida en",
  "punto de retiro",
  "punto de recogida",
  // Transportadoras (palabras clave de oficinas de couriers)
  "interrapidisimo",
  "inter rapidisimo",
  "servientrega",
  "coordinadora",
  "envia",
  "tcc",
  "deprisa",
  "domina",
  "saferbo",
  "envíos urbano",
  "envios urbano",
  // Terminales / agencias
  "terminal de transporte",
  "agencia ",
  "sucursal "
];

// Palabras que SOLAS no son rechazo pero combinadas con "oficina" sí
const OFFICE_STRONG = ["oficina ", "oficinas ", "ofic "];

export function isOfficeAddress(rawAddress: string): boolean {
  const addr = normalizeZoneName(rawAddress || "");
  if (!addr) return false;

  // Match directo con keywords compuestas
  for (const kw of OFFICE_KEYWORDS) {
    if (addr.includes(kw)) return true;
  }

  // Match con prefijo "oficina/oficinas/ofic" (cualquier oficina cuenta)
  for (const kw of OFFICE_STRONG) {
    if (addr.includes(kw)) return true;
  }

  // "oficinas" sin espacio (al final por ejemplo)
  if (/\boficinas?\b/i.test(addr) || /\bofic\b/i.test(addr)) return true;

  return false;
}

export function buildOfficeRejectionMessage(
  firstName: string,
  orderNumber: string,
  rawAddress: string
): string {
  const greeting = firstName ? `Hola ${firstName} 😊` : "Hola 😊";
  return [
    greeting,
    "",
    `Notamos que tu dirección de envío "${rawAddress}" parece ser una *oficina*.`,
    "",
    "Lamentablemente *no realizamos envíos a oficinas* (ni de transportadoras ni puntos de recogida), porque las novedades de entrega aumentan mucho y el cliente termina sin recibir su pedido.",
    "",
    `Para poder despachar tu pedido *${orderNumber}*, necesitamos una *dirección residencial o comercial* donde puedas recibirlo personalmente (calle/carrera + número + barrio).`,
    "",
    "🤝 Si nos envías una dirección alternativa por aquí, con gusto la actualizamos y despachamos. Si no, el pedido se cancelará automáticamente.",
    "",
    "Esperamos tu respuesta 💛"
  ].join("\n");
}

// ─── API pública ──────────────────────────────────────────────────────────────

export interface BlockedZoneResult {
  blocked: boolean;
  matchedDepartment?: string;
  matchedCity?: string;
  reason?: string;
}

/**
 * Determina si una zona está bloqueada para envío.
 * Matchea por departamento o ciudad (lo que aplique).
 */
export function isBlockedZone(
  city: string | null | undefined,
  department: string | null | undefined,
  departmentCode?: string | null | undefined
): BlockedZoneResult {
  const normCity = normalizeZoneName(city || "");
  const normDept = normalizeZoneName(department || "");
  const normCode = normalizeZoneName(departmentCode || "");

  const blockedDepts  = getConfiguredBlockedDepartments();
  const blockedCities = getConfiguredBlockedCities();
  const blockedCodes  = getConfiguredBlockedDepartmentCodes();

  // 1) Match por departamento (cualquier dept que contenga o sea contenido en blocked)
  for (const blocked of blockedDepts) {
    if (!blocked) continue;
    if (normDept && (normDept.includes(blocked) || blocked.includes(normDept))) {
      return {
        blocked: true,
        matchedDepartment: department || undefined,
        reason: `Departamento "${department}" no cubierto`
      };
    }
  }

  // 1b) Match por código de provincia (Shopify a veces solo manda "VAU", "SAP", etc.)
  if (normCode) {
    for (const blocked of blockedCodes) {
      if (blocked && normCode === blocked) {
        return {
          blocked: true,
          matchedDepartment: department || departmentCode || undefined,
          reason: `Código de departamento "${departmentCode}" no cubierto`
        };
      }
    }
  }

  // 2) Match por ciudad
  for (const blocked of blockedCities) {
    if (!blocked) continue;
    if (normCity && (normCity === blocked || normCity.includes(blocked))) {
      return {
        blocked: true,
        matchedCity: city || undefined,
        reason: `Ciudad "${city}" no cubierta`
      };
    }
  }

  return { blocked: false };
}

// ─── Mensaje de rechazo al cliente ────────────────────────────────────────────

export function buildRejectionMessage(
  firstName: string,
  orderNumber: string,
  zoneLabel: string
): string {
  const greeting = firstName ? `Hola ${firstName} 😊` : "Hola 😊";
  return [
    greeting,
    "",
    `Lamentamos informarte que actualmente *no realizamos envíos a ${zoneLabel}* debido a restricciones logísticas con nuestras transportadoras.`,
    "",
    `Tu pedido *${orderNumber}* será cancelado automáticamente.`,
    "",
    "🤝 *¿Tienes alternativa?*",
    "Si conoces a alguien en otra ciudad de Colombia (familiar, amigo) que pueda recibir tu pedido, escríbenos con la dirección alternativa y con gusto te ayudamos a redirigirlo.",
    "",
    "📦 *¿Prefieres coordinar transporte directo?*",
    "También podemos coordinar el envío hasta una agencia de carga de tu elección. El costo del último tramo correría por tu cuenta.",
    "",
    "Escríbenos por aquí mismo y un asesor te ayuda 💛"
  ].join("\n");
}
