export interface GraphNode {
  id: string;
  label: string;
  kind: string | null;
  color: string;
  val: number;
  file: string | null;
  line: number | null;
  x?: number;
  y?: number;
}

export interface GraphLink {
  source: string | { id: string };
  target: string | { id: string };
  label?: string;
}
