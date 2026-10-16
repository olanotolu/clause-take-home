import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Joins class names and lets the later Tailwind utility win (`cn("px-2", cond && "px-4")` is `px-4`). */
export const cn = (...inputs: ClassValue[]): string => twMerge(clsx(inputs));
