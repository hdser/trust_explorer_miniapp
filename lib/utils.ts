import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function shortenAddress(address: string, chars = 4): string {
  if (!address) return "";
  const head = address.startsWith("0x") ? 2 + chars : chars;
  return `${address.slice(0, head)}…${address.slice(-chars)}`;
}
