import { NextRequest, NextResponse } from "next/server";

// Protege el dashboard y las APIs internas detrás del login.
// Rutas públicas: la página de login, los endpoints de auth y los webhooks de
// Shopify (Shopify no manda cookies — debe seguir entrando sin sesión).
//
// Nota: el middleware corre en el runtime edge y NO puede consultar SQLite,
// así que aquí solo verificamos que EXISTA la cookie de sesión. La validación
// real contra la base de datos la hace la página (server component) y cada API.

const PUBLIC_PREFIXES = ["/login", "/api/auth", "/api/webhooks"];

export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;

  if (PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return NextResponse.next();
  }

  const hasSession = Boolean(req.cookies.get("session")?.value);
  if (hasSession) return NextResponse.next();

  // Sin sesión: las APIs responden 401, las páginas redirigen al login.
  if (pathname.startsWith("/api")) {
    return NextResponse.json({ error: "No autenticado" }, { status: 401 });
  }

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  return NextResponse.redirect(url);
}

export const config = {
  // Excluye archivos estáticos de Next y la carpeta pública de mockups.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|mockups).*)"]
};
