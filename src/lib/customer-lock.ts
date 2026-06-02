import { normalizePhone } from "./phone-utils";

const activeLocks = new Set<string>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withCustomerLock(
  phone: string,
  task: () => Promise<void>
): Promise<void> {
  const key = normalizePhone(phone);

  while (activeLocks.has(key)) {
    console.log(`[bot] Esperando lock para cliente ${key}`);
    await sleep(300);
  }

  activeLocks.add(key);
  console.log(`[bot] Lock adquirido para cliente ${key}`);

  try {
    await task();
  } finally {
    activeLocks.delete(key);
    console.log(`[bot] Lock liberado para cliente ${key}`);
  }
}
