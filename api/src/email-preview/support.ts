import { clients, matrix } from "./vendor/caniemail/matrix.js";

export { clients };
export type Client = (typeof clients)[number];
export const features: readonly string[] = Object.freeze(Object.keys(matrix));

export function support(feature: string, client: Client): "yes" | "no" | "partial" | "unknown" {
  const row = Object.hasOwn(matrix, feature) ? matrix[feature] : undefined;
  switch (row?.[clients.indexOf(client)]) {
    case "y": return "yes";
    case "n": return "no";
    case "a": return "partial";
    default: return "unknown";
  }
}
