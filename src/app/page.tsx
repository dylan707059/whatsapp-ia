import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getAccountBySessionToken } from "@/lib/db";
import ConnectionGate from "@/components/ConnectionGate";

export const dynamic = "force-dynamic";

export default async function Home() {
  // Validación real de la sesión contra la base de datos (el middleware solo
  // comprueba que la cookie exista; aquí confirmamos que sea válida).
  const token = (await cookies()).get("session")?.value;
  const account = token ? getAccountBySessionToken(token) : undefined;

  if (!account) redirect("/login");

  return <ConnectionGate />;
}
